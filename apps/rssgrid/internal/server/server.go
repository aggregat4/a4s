package server

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"html/template"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/aggregat4/a4s/apps/rssgrid/internal/db"
	"github.com/aggregat4/a4s/apps/rssgrid/internal/feed"
	"github.com/aggregat4/a4s/apps/rssgrid/internal/templates"
	baseliboidc "github.com/aggregat4/a4s/pkg/auth/oidc"
	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/gorilla/sessions"
)

type Server struct {
	store      StoreInterface
	sessions   *sessions.CookieStore
	fetcher    feed.FeedFetcher
	templates  *template.Template
	oidcConfig *baseliboidc.OidcConfiguration
}

// StoreInterface defines the interface that the server needs
type StoreInterface interface {
	GetUserFeeds(userID int64) ([]db.Feed, error)
	GetUserLatestPosts(userID int64, limit int) (map[int64][]db.Post, error)
	GetPostForUser(userID, postID int64) (*db.Post, error)
	GetOrCreateUser(subject, issuer string) (int64, error)
	AddFeedForUser(userID int64, url string) (int64, error)
	UpdateFeedTitle(feedID int64, title string) error
	UpdateFeedCacheInfo(feedID int64, etag, lastModified string, cacheUntil time.Time) error
	InsertPost(feedID int64, guid, title, link string, publishedAt time.Time, content string) (bool, error)
	DeleteFeedForUser(userID, feedID int64) error
	MarkPostAsSeenForUser(userID, postID int64) error
	MarkAllFeedPostsAsSeenForUser(userID, feedID int64) error
	GetUserPostsPerFeed(userID int64) (int, error)
	MoveFeedUp(userID int64, feedID int64) error
	MoveFeedDown(userID int64, feedID int64) error
	GetUserColumns(userID int64) (int, error)
	SetUserPreferences(userID int64, postsPerFeed, columns int) error
}

// Bounds for the user display preferences. The column bound matches the
// feed-column-N classes in styles.css.
const (
	MinPostsPerFeed = 1
	MaxPostsPerFeed = 50
	MinColumns      = 1
	MaxColumns      = 5
)

type FlashMessage struct {
	Message string
	Type    string
}

// addFlashMessage adds a flash message to the session
func (s *Server) addFlashMessage(w http.ResponseWriter, r *http.Request, message, flashType string) {
	session, err := s.sessions.Get(r, "user_session")
	if err != nil {
		slog.Error("Error getting session for flash message", "err", err)
		return
	}

	session.AddFlash(message, flashType)
	if err := session.Save(r, w); err != nil {
		slog.Error("Error saving session with flash message", "err", err)
	}
}

// addErrorFlash adds an error flash message to the session
func (s *Server) addErrorFlash(w http.ResponseWriter, r *http.Request, message string) {
	s.addFlashMessage(w, r, message, "error")
}

// addSuccessFlash adds a success flash message to the session
func (s *Server) addSuccessFlash(w http.ResponseWriter, r *http.Request, message string) {
	s.addFlashMessage(w, r, message, "success")
}

// getFlashMessages retrieves all flash messages from the session
func (s *Server) getFlashMessages(w http.ResponseWriter, r *http.Request) []FlashMessage {
	session, err := s.sessions.Get(r, "user_session")
	var flashMessages []FlashMessage
	if err != nil {
		slog.Error("Error getting session for flash messages", "err", err)
		return flashMessages
	}

	// Get error flash messages
	flashes := session.Flashes("error")
	for _, flash := range flashes {
		flashMessages = append(flashMessages, FlashMessage{Message: flash.(string), Type: "error"})
	}

	// Get success flash messages
	flashes = session.Flashes("success")
	for _, flash := range flashes {
		flashMessages = append(flashMessages, FlashMessage{Message: flash.(string), Type: "success"})
	}

	// Save the session after consuming flash messages to remove them from the session
	if err := session.Save(r, w); err != nil {
		slog.Error("Error saving session", "err", err)
	}

	return flashMessages
}

type contextKey int

const userIDKey contextKey = 0

// requireUser resolves the signed-in user's ID from the session and stores it
// in the request context for the protected handlers. The OIDC middleware has
// already redirected unauthenticated requests, so a missing ID means the
// session is unusable.
func (s *Server) requireUser(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		session, err := s.sessions.Get(r, "user_session")
		if err != nil {
			slog.Warn("Error getting session", "err", err)
		}
		var userID int64
		if session != nil {
			userID, _ = session.Values["user_id"].(int64)
		}
		if userID == 0 {
			http.Error(w, "User not authenticated", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, withUserID(r, userID))
	})
}

// withUserID returns a copy of r carrying the given user ID.
func withUserID(r *http.Request, userID int64) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), userIDKey, userID))
}

// userIDFrom returns the user ID stored by requireUser. Handlers behind
// requireUser can rely on it being set.
func userIDFrom(r *http.Request) int64 {
	userID, _ := r.Context().Value(userIDKey).(int64)
	return userID
}

// pathID parses the named URL parameter as an int64 ID. On failure it writes
// a 400 response mentioning the kind of resource and returns false.
func pathID(w http.ResponseWriter, r *http.Request, param, kind string) (int64, bool) {
	id, err := strconv.ParseInt(chi.URLParam(r, param), 10, 64)
	if err != nil {
		http.Error(w, "Invalid "+kind+" ID", http.StatusBadRequest)
		return 0, false
	}
	return id, true
}

// requiredTemplates are the page templates the handlers render.
var requiredTemplates = []string{"dashboard.html", "settings.html", "post.html"}

// render executes the named template into a buffer and only writes it to the
// response when rendering succeeded, so a template error yields a clean 500
// instead of a partial page followed by an error message.
func (s *Server) render(w http.ResponseWriter, name string, data any) {
	var buf bytes.Buffer
	if err := s.templates.ExecuteTemplate(&buf, name, data); err != nil {
		slog.Error("Error rendering template", "template", name, "err", err)
		http.Error(w, "Error rendering page", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if _, err := buf.WriteTo(w); err != nil {
		slog.Warn("Error writing response", "template", name, "err", err)
	}
}

func NewServer(store StoreInterface, oidcConfig *baseliboidc.OidcConfiguration, sessionKey string, secureCookies bool) (*Server, error) {
	sessionStore := sessions.NewCookieStore([]byte(sessionKey))

	// Configure session store options to ensure flash messages persist.
	// MaxAge is 30 days (86400 * 30 seconds). Secure is driven by the
	// secure_cookies config flag: enable it behind HTTPS in production.
	sessionStore.Options = &sessions.Options{
		Path:     "/",
		MaxAge:   86400 * 30, // 30 days
		HttpOnly: true,
		Secure:   secureCookies,
		SameSite: http.SameSiteLaxMode,
	}

	templates, err := templates.LoadTemplates()
	if err != nil {
		return nil, fmt.Errorf("error loading templates: %w", err)
	}

	for _, name := range requiredTemplates {
		if templates.Lookup(name) == nil {
			return nil, fmt.Errorf("required template %q not found", name)
		}
	}

	return &Server{
		store:      store,
		sessions:   sessionStore,
		fetcher:    feed.NewFetcher(),
		templates:  templates,
		oidcConfig: oidcConfig,
	}, nil
}

// logErrorAndRespond logs an error with additional key/value attributes, then
// sends an HTTP error response
func (s *Server) logErrorAndRespond(w http.ResponseWriter, statusCode int, userMessage, logMessage string, err error, attrs ...any) {
	slog.Error(logMessage, append([]any{"err", err, "status", statusCode}, attrs...)...)
	http.Error(w, userMessage, statusCode)
}

// isPublicPath reports whether a request path should bypass OIDC authentication.
// Public paths include the OIDC callback and the favicon (which browsers request
// pre-login and must not trigger an auth redirect loop).
func isPublicPath(path string) bool {
	return path == "/auth/callback" || path == "/favicon.svg"
}

// handleFavicon serves the embedded SVG favicon. It is registered as a public
// route so it loads without an authenticated session.
func (s *Server) handleFavicon(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "image/svg+xml")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	if _, err := w.Write(templates.Favicon()); err != nil {
		slog.Warn("Error writing favicon", "err", err)
	}
}

func (s *Server) StartWithContext(ctx context.Context, addr string) error {
	oidcAuthenticationMiddleware := s.oidcConfig.CreateOidcAuthenticationMiddleware(
		func(r *http.Request) bool {
			session, err := s.sessions.Get(r, "user_session")
			if err != nil {
				slog.Warn("Error getting session in auth middleware", "err", err)
				return false
			}
			return session.Values["user_id"] != nil
		},
		func(r *http.Request) bool {
			return isPublicPath(r.URL.Path)
		},
	)

	oidcCallbackHandler := s.oidcConfig.CreateOidcCallbackHandler(
		baseliboidc.CreateSTDSessionBasedOidcDelegate(
			func(w http.ResponseWriter, r *http.Request, idToken *oidc.IDToken) error {
				userId, err := s.store.GetOrCreateUser(idToken.Subject, idToken.Issuer)
				if err != nil {
					slog.Error("Error getting or creating user",
						"subject", idToken.Subject, "issuer", idToken.Issuer, "err", err)
					return fmt.Errorf("error getting or creating user: %w", err)
				}
				session, err := s.sessions.Get(r, "user_session")
				if err != nil {
					// An undecodable cookie (for example after a session key
					// rotation) must not fail the login. gorilla returns a
					// fresh session in that case, which we populate and save
					// to replace the invalid cookie.
					slog.Info("Discarding invalid session", "userId", userId, "err", err)
					if session == nil {
						return fmt.Errorf("error getting session: %w", err)
					}
				}
				session.Values["user_id"] = userId
				if err := session.Save(r, w); err != nil {
					slog.Error("Error saving session", "userId", userId, "err", err)
					return fmt.Errorf("error saving session: %w", err)
				}
				return nil
			},
			"/",
		),
	)

	r := chi.NewRouter()

	// Log every request (including authentication redirects), then recover
	// panics in anything below, including the authentication middleware.
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(oidcAuthenticationMiddleware)

	// Public routes
	r.Get("/auth/callback", oidcCallbackHandler)
	r.Get("/favicon.svg", s.handleFavicon)

	// Static files
	fileServer := templates.CreateStaticFileServer()
	r.Handle("/static/*", http.StripPrefix("/static/", fileServer))

	// Protected routes
	r.Group(func(r chi.Router) {
		r.Use(s.requireUser)
		r.Get("/", s.handleDashboard)
		r.Get("/settings", s.handleSettings)
		r.Get("/posts/{postId}", s.handleGetPost)
		r.Post("/settings/feeds", s.handleAddFeed)
		r.Post("/settings/feeds/{feedId}/delete", s.handleDeleteFeed)
		r.Post("/settings/preferences", s.handleUpdatePreferences)
		r.Post("/settings/feeds/{feedId}/move-up", s.handleMoveFeedUp)
		r.Post("/settings/feeds/{feedId}/move-down", s.handleMoveFeedDown)
		r.Post("/posts/{postId}/seen", s.handleMarkPostSeen)
		r.Post("/feeds/{feedId}/seen", s.handleMarkAllSeen)
	})

	server := &http.Server{
		Addr:    addr,
		Handler: r,
	}

	slog.Info("Starting server", "addr", addr)

	// Start server in a goroutine
	go func() {
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("HTTP server error", "err", err)
		}
	}()

	// Wait for context cancellation
	<-ctx.Done()

	slog.Info("Shutting down HTTP server")

	// Create a context with timeout for graceful shutdown
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := server.Shutdown(shutdownCtx); err != nil {
		slog.Error("Error during server shutdown", "err", err)
		return err
	}

	slog.Info("HTTP server shutdown complete")
	return nil
}

func splitFeedsIntoColumns[T any](feeds []T, numCols int) [][]T {
	if numCols < 1 {
		numCols = 1
	}
	columns := make([][]T, numCols)
	for i, feed := range feeds {
		col := i % numCols
		columns[col] = append(columns[col], feed)
	}
	return columns
}

func (s *Server) handleDashboard(w http.ResponseWriter, r *http.Request) {
	userId := userIDFrom(r)

	feeds, err := s.store.GetUserFeeds(userId)
	if err != nil {
		s.logErrorAndRespond(w, http.StatusInternalServerError, "Error fetching feeds", "Error fetching feeds for user", err, "userId", userId)
		return
	}

	// Get user's posts per feed preference
	postsPerFeed, err := s.store.GetUserPostsPerFeed(userId)
	if err != nil {
		s.logErrorAndRespond(w, http.StatusInternalServerError, "Error fetching user preferences", "Error fetching posts per feed preference", err, "userId", userId)
		return
	}

	// Get user's column preference
	columns, err := s.store.GetUserColumns(userId)
	if err != nil {
		s.logErrorAndRespond(w, http.StatusInternalServerError, "Error fetching user preferences", "Error fetching columns preference", err, "userId", userId)
		return
	}

	type FeedData struct {
		Feed  db.Feed
		Posts []db.Post
	}

	posts, err := s.store.GetUserLatestPosts(userId, postsPerFeed)
	if err != nil {
		s.logErrorAndRespond(w, http.StatusInternalServerError, "Error fetching posts", "Error fetching posts for user", err, "userId", userId)
		return
	}

	feedData := make([]FeedData, 0, len(feeds))
	for _, f := range feeds {
		feedData = append(feedData, FeedData{Feed: f, Posts: posts[f.ID]})
	}

	columnsData := splitFeedsIntoColumns(feedData, columns)

	data := struct {
		Columns     [][]FeedData
		ColumnCount int
	}{
		Columns:     columnsData,
		ColumnCount: columns,
	}

	s.render(w, "dashboard.html", data)
}

func (s *Server) handleSettings(w http.ResponseWriter, r *http.Request) {
	userId := userIDFrom(r)

	feeds, err := s.store.GetUserFeeds(userId)
	if err != nil {
		s.logErrorAndRespond(w, http.StatusInternalServerError, "Error fetching feeds", "Error fetching feeds for user", err, "userId", userId)
		return
	}

	// Get user's posts per feed preference
	postsPerFeed, err := s.store.GetUserPostsPerFeed(userId)
	if err != nil {
		s.logErrorAndRespond(w, http.StatusInternalServerError, "Error fetching user preferences", "Error fetching posts per feed preference", err, "userId", userId)
		return
	}

	// Get user's column preference
	columns, err := s.store.GetUserColumns(userId)
	if err != nil {
		s.logErrorAndRespond(w, http.StatusInternalServerError, "Error fetching user preferences", "Error fetching columns preference", err, "userId", userId)
		return
	}

	// Get flash messages
	flashMessages := s.getFlashMessages(w, r)

	data := struct {
		Feeds         []db.Feed
		FlashMessages []FlashMessage
		PostsPerFeed  int
		Columns       int
	}{
		Feeds:         feeds,
		FlashMessages: flashMessages,
		PostsPerFeed:  postsPerFeed,
		Columns:       columns,
	}

	s.render(w, "settings.html", data)
}

func (s *Server) handleAddFeed(w http.ResponseWriter, r *http.Request) {
	userId := userIDFrom(r)

	url := r.FormValue("url")
	if url == "" {
		// Set error message and redirect
		s.addErrorFlash(w, r, "URL is required")
		http.Redirect(w, r, "/settings", http.StatusSeeOther)
		return
	}

	if s.fetcher == nil {
		s.logErrorAndRespond(w, http.StatusInternalServerError, "Feed fetching is not available", "No fetcher configured", nil)
		return
	}

	// Fetch unconditionally: this both validates the URL and provides the
	// initial posts and cache information.
	result, err := s.fetcher.FetchFeed(r.Context(), url, feed.Validators{})
	if err != nil {
		slog.Warn("Error fetching feed to add", "url", url, "err", err)
		s.addErrorFlash(w, r, "Invalid feed URL or unable to fetch feed")
		http.Redirect(w, r, "/settings", http.StatusSeeOther)
		return
	}

	feedId, err := s.store.AddFeedForUser(userId, url)
	if err != nil {
		slog.Error("Error adding feed", "url", url, "userId", userId, "err", err)
		s.addErrorFlash(w, r, "Error adding feed. Please try again.")
		http.Redirect(w, r, "/settings", http.StatusSeeOther)
		return
	}

	if !result.NotModified() {
		if err := s.store.UpdateFeedCacheInfo(feedId, result.Cache.ETag, result.Cache.LastModified, result.Cache.CacheUntil); err != nil {
			slog.Error("Error storing cache info", "feedId", feedId, "err", err)
		}
		feed.IngestContent(s.store, feedId, "", result.Content)
	}

	// Set a success message in the session
	s.addSuccessFlash(w, r, "Feed added successfully!")

	http.Redirect(w, r, "/settings", http.StatusSeeOther)
}

func (s *Server) handleDeleteFeed(w http.ResponseWriter, r *http.Request) {
	feedId, ok := pathID(w, r, "feedId", "feed")
	if !ok {
		return
	}
	userId := userIDFrom(r)

	if err := s.store.DeleteFeedForUser(userId, feedId); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			http.Error(w, "Feed not found", http.StatusNotFound)
			return
		}
		s.logErrorAndRespond(w, http.StatusInternalServerError, "Error deleting feed", "Error deleting feed for user", err, "feedId", feedId, "userId", userId)
		return
	}

	http.Redirect(w, r, "/settings", http.StatusSeeOther)
}

func (s *Server) handleMarkPostSeen(w http.ResponseWriter, r *http.Request) {
	postId, ok := pathID(w, r, "postId", "post")
	if !ok {
		return
	}
	userId := userIDFrom(r)

	if err := s.store.MarkPostAsSeenForUser(userId, postId); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			http.Error(w, "Post not found", http.StatusNotFound)
			return
		}
		s.logErrorAndRespond(w, http.StatusInternalServerError, "Error marking post as seen", "Error marking post as seen for user", err, "postId", postId, "userId", userId)
		return
	}

	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleMarkAllSeen(w http.ResponseWriter, r *http.Request) {
	feedId, ok := pathID(w, r, "feedId", "feed")
	if !ok {
		return
	}
	userId := userIDFrom(r)

	if err := s.store.MarkAllFeedPostsAsSeenForUser(userId, feedId); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			http.Error(w, "Feed not found", http.StatusNotFound)
			return
		}
		s.logErrorAndRespond(w, http.StatusInternalServerError, "Error marking all posts as seen", "Error marking all posts as seen for feed", err, "feedId", feedId, "userId", userId)
		return
	}

	http.Redirect(w, r, "/", http.StatusSeeOther)
}

func (s *Server) handleUpdatePreferences(w http.ResponseWriter, r *http.Request) {
	userId := userIDFrom(r)

	postsPerFeed, err := strconv.Atoi(r.FormValue("postsPerFeed"))
	if err != nil || postsPerFeed < MinPostsPerFeed || postsPerFeed > MaxPostsPerFeed {
		s.addErrorFlash(w, r, fmt.Sprintf("Posts per feed must be a number between %d and %d", MinPostsPerFeed, MaxPostsPerFeed))
		http.Redirect(w, r, "/settings", http.StatusSeeOther)
		return
	}

	columns, err := strconv.Atoi(r.FormValue("columns"))
	if err != nil || columns < MinColumns || columns > MaxColumns {
		s.addErrorFlash(w, r, fmt.Sprintf("Number of columns must be a number between %d and %d", MinColumns, MaxColumns))
		http.Redirect(w, r, "/settings", http.StatusSeeOther)
		return
	}

	if err := s.store.SetUserPreferences(userId, postsPerFeed, columns); err != nil {
		s.logErrorAndRespond(w, http.StatusInternalServerError, "Error updating preferences", "Error updating preferences for user", err, "userId", userId, "postsPerFeed", postsPerFeed, "columns", columns)
		return
	}

	// Set a success message in the session
	s.addSuccessFlash(w, r, "Preferences updated successfully!")

	http.Redirect(w, r, "/settings", http.StatusSeeOther)
}

func (s *Server) handleGetPost(w http.ResponseWriter, r *http.Request) {
	postId, ok := pathID(w, r, "postId", "post")
	if !ok {
		return
	}
	userId := userIDFrom(r)

	post, err := s.store.GetPostForUser(userId, postId)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			http.Error(w, "Post not found", http.StatusNotFound)
			return
		}
		s.logErrorAndRespond(w, http.StatusInternalServerError, "Error fetching post", "Error fetching post for user", err, "postId", postId, "userId", userId)
		return
	}

	data := struct {
		Post struct {
			ID          int64
			Title       string
			Link        string
			PublishedAt time.Time
			Content     template.HTML
		}
	}{
		Post: struct {
			ID          int64
			Title       string
			Link        string
			PublishedAt time.Time
			Content     template.HTML
		}{
			ID:          post.ID,
			Title:       post.Title,
			Link:        post.Link,
			PublishedAt: post.PublishedAt,
			Content:     template.HTML(post.Content),
		},
	}

	s.render(w, "post.html", data)
}

// handleMoveError maps store errors from moving a feed to a response. Moving
// past the first or last position is a no-op rather than an error, since the
// settings page may be stale.
func (s *Server) handleMoveError(w http.ResponseWriter, r *http.Request, err error, direction string, feedID, userID int64) {
	switch {
	case errors.Is(err, sql.ErrNoRows):
		http.Error(w, "Feed not found", http.StatusNotFound)
	case errors.Is(err, db.ErrNoAdjacentFeed):
		http.Redirect(w, r, "/settings", http.StatusSeeOther)
	default:
		s.logErrorAndRespond(w, http.StatusInternalServerError, "Error moving feed "+direction, "Error moving feed "+direction+" for user", err, "feedId", feedID, "userId", userID)
	}
}

func (s *Server) handleMoveFeedUp(w http.ResponseWriter, r *http.Request) {
	feedId, ok := pathID(w, r, "feedId", "feed")
	if !ok {
		return
	}
	userId := userIDFrom(r)

	if err := s.store.MoveFeedUp(userId, feedId); err != nil {
		s.handleMoveError(w, r, err, "up", feedId, userId)
		return
	}

	http.Redirect(w, r, "/settings", http.StatusSeeOther)
}

func (s *Server) handleMoveFeedDown(w http.ResponseWriter, r *http.Request) {
	feedId, ok := pathID(w, r, "feedId", "feed")
	if !ok {
		return
	}
	userId := userIDFrom(r)

	if err := s.store.MoveFeedDown(userId, feedId); err != nil {
		s.handleMoveError(w, r, err, "down", feedId, userId)
		return
	}

	http.Redirect(w, r, "/settings", http.StatusSeeOther)
}
