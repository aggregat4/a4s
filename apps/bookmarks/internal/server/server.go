package server

import (
	"bytes"
	"embed"
	"errors"
	"html/template"
	"io/fs"
	"log/slog"
	"math"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/gorilla/feeds"
	"github.com/gorilla/sessions"

	"github.com/aggregat4/a4s/apps/bookmarks/internal/domain"
	"github.com/aggregat4/a4s/apps/bookmarks/internal/repository"
	baseliboidc "github.com/aggregat4/a4s/pkg/auth/oidc"
	"github.com/aggregat4/a4s/pkg/lang"
)

//go:embed public/views/*.html
var viewTemplates embed.FS

//go:embed public/images/*.png
var images embed.FS

// sessionCookieName is the cookie that holds the logged-in user. Keeping its
// name keeps users logged in across server versions.
const sessionCookieName = "user_session"

type Controller struct {
	Store  *repository.Store
	Config domain.Configuration

	templates *template.Template
	sessions  *sessions.CookieStore
}

// RunServer serves Bookmarks until the server fails.
func RunServer(controller Controller, oidcConfig *baseliboidc.OidcConfiguration) {
	server := &http.Server{
		Addr:    ":" + strconv.Itoa(controller.Config.ServerPort),
		Handler: NewHandler(&controller, oidcConfig),
		// Set server timeouts based on advice from https://blog.cloudflare.com/the-complete-guide-to-golang-net-http-timeouts/#1687428081
		ReadTimeout:  time.Duration(controller.Config.ServerReadTimeoutSeconds) * time.Second,
		WriteTimeout: time.Duration(controller.Config.ServerWriteTimeoutSeconds) * time.Second,
	}
	slog.Info("Starting server", "addr", server.Addr)
	err := server.ListenAndServe()
	slog.Error("Server stopped", "err", err)
	os.Exit(1)
}

// NewHandler returns the Bookmarks handler: every page needs a logged-in
// user, except the login callback and the read-later feeds.
func NewHandler(controller *Controller, oidcConfig *baseliboidc.OidcConfiguration) http.Handler {
	controller.init()
	mux := http.NewServeMux()
	controller.routes(mux)
	mux.Handle("GET /oidccallback", oidcConfig.CreateOidcCallbackHandler(
		baseliboidc.CreateSTDSessionBasedOidcDelegate(controller.logIn, "/bookmarks"),
	))
	authenticate := oidcConfig.CreateOidcAuthenticationMiddleware(controller.isLoggedIn, isPublic)
	return withMiddleware(authenticate(mux))
}

// newHandlerWithoutLogin serves the pages without asking anyone to log in,
// for tests that set the session cookie themselves.
func newHandlerWithoutLogin(controller *Controller) http.Handler {
	controller.init()
	mux := http.NewServeMux()
	controller.routes(mux)
	return withMiddleware(mux)
}

// withMiddleware logs each request, recovers from panics, compresses
// responses and rejects cross-origin form posts. Browsers mark where a
// request comes from with Sec-Fetch-Site; without it, the Origin header must
// match the Host, which the proxy forwards.
func withMiddleware(next http.Handler) http.Handler {
	handler := http.NewCrossOriginProtection().Handler(next)
	handler = middleware.Compress(5)(handler)
	handler = middleware.Recoverer(handler)
	return middleware.Logger(handler)
}

func isPublic(r *http.Request) bool {
	return r.URL.Path == "/oidccallback" ||
		(r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/feeds/"))
}

func (controller *Controller) init() {
	funcMap := template.FuncMap{
		"highlight": func(text string) template.HTML {
			return template.HTML(highlight(template.HTMLEscapeString(text)))
		},
	}
	controller.templates = template.Must(template.New("").Funcs(funcMap).ParseFS(viewTemplates, "public/views/*.html"))
	controller.sessions = sessions.NewCookieStore([]byte(controller.Config.SessionCookieSecretKey))
}

func (controller *Controller) routes(mux *http.ServeMux) {
	imageFS, err := fs.Sub(images, "public/images")
	if err != nil {
		panic(err)
	}
	mux.Handle("GET /images/{file}", http.StripPrefix("/images/", http.FileServerFS(imageFS)))
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/bookmarks", http.StatusFound)
	})
	mux.HandleFunc("GET /bookmarks", controller.showBookmarks)
	mux.HandleFunc("POST /bookmarks", controller.addBookmark)
	mux.HandleFunc("GET /addbookmark", controller.showAddBookmark)
	mux.HandleFunc("POST /deletebookmark", controller.deleteBookmark)
	mux.HandleFunc("GET /feeds/{id}", controller.showFeed)
}

// isLoggedIn tells whether the request carries the session of a logged-in
// user. A session cookie that cannot be read, for example after the secret
// key changed, counts as logged out, and logging in replaces it.
func (controller *Controller) isLoggedIn(r *http.Request) bool {
	session, err := controller.sessions.Get(r, sessionCookieName)
	if err != nil {
		slog.Warn("Error getting session in auth middleware (likely invalid cookie)", "err", err)
		return false
	}
	return session.Values["user_id"] != nil
}

// logIn stores the user the identity provider vouched for in the session.
func (controller *Controller) logIn(w http.ResponseWriter, r *http.Request, idToken *oidc.IDToken) error {
	// Get returns a new session when the cookie cannot be read, which
	// saving then replaces.
	session, err := controller.sessions.Get(r, sessionCookieName)
	if err != nil {
		slog.Warn("Error getting session in OIDC callback, likely due to invalid cookie (e.g., after server restart with new secret)", "err", err)
	}
	userId, err := controller.Store.FindOrCreateUser(idToken.Subject)
	if err != nil {
		return err
	}
	session.Values["user_id"] = userId
	return session.Save(r, w)
}

func (controller *Controller) userId(r *http.Request) (int, error) {
	session, err := controller.sessions.Get(r, sessionCookieName)
	if err != nil {
		return -1, err
	}
	userId, ok := session.Values["user_id"].(int)
	if !ok {
		return -1, errors.New("no user in session")
	}
	return userId, nil
}

// render executes the named template into a buffer and only writes it to the
// response when rendering succeeded, so a template error yields a clean 500
// instead of a partial page.
func (controller *Controller) render(w http.ResponseWriter, status int, name string, data any) {
	var buf bytes.Buffer
	if err := controller.templates.ExecuteTemplate(&buf, name, data); err != nil {
		slog.Error("Error rendering template", "template", name, "err", err)
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=UTF-8")
	w.WriteHeader(status)
	if _, err := buf.WriteTo(w); err != nil {
		slog.Warn("Error writing response", "template", name, "err", err)
	}
}

func (controller *Controller) handleInternalServerError(w http.ResponseWriter, err error) {
	slog.Error("Internal server error", "err", err)
	controller.render(w, http.StatusInternalServerError, "error-internalserver", nil)
}

func highlight(text string) string {
	return strings.ReplaceAll(strings.ReplaceAll(text, "{{mark}}", "<mark>"), "{{endmark}}", "</mark>")
}

type AddBookmarkPage struct {
	Bookmark domain.Bookmark
}

func (controller *Controller) showBookmarks(w http.ResponseWriter, r *http.Request) {
	userid, err := controller.userId(r)
	if err != nil {
		controller.handleInternalServerError(w, err)
		return
	}
	currentLastModifiedDateTime, err := controller.Store.GetLastModifiedDate(userid)
	if err != nil {
		controller.handleInternalServerError(w, err)
		return
	}
	if r.Header.Get("If-Modified-Since") == currentLastModifiedDateTime.Format(http.TimeFormat) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	query := r.URL.Query()
	var direction = domain.DirectionRight
	if query.Get("direction") != "" {
		direction, err = strconv.Atoi(query.Get("direction"))
		if err != nil {
			direction = domain.DirectionRight
		}
		if direction != 0 && direction != 1 {
			direction = domain.DirectionRight
		}
	}
	var offset int64
	if direction == domain.DirectionLeft {
		offset = 0
	} else {
		offset = math.MaxInt64
	}
	if query.Get("offset") != "" {
		offset, _ = strconv.ParseInt(query.Get("offset"), 10, 64)
		// ignore error here, we'll just use the default value
	}
	var searchQuery = query.Get("q")
	bookmarks, err := controller.Store.GetBookmarks(searchQuery, direction, userid, offset, controller.Config.BookmarksPageSize)
	if err != nil {
		controller.handleInternalServerError(w, err)
		return
	}
	moreResultsLeft := len(bookmarks) == (controller.Config.BookmarksPageSize + 1)
	if moreResultsLeft {
		bookmarks = bookmarks[:len(bookmarks)-1]
	}
	if direction == domain.DirectionLeft {
		// if we are moving back in the list of bookmarks the query has given us an ascending list of them
		// we need to reverse them to satisfy the invariant of having a descending list of bookmarks
		for i, j := 0, len(bookmarks)-1; i < j; i, j = i+1, j-1 {
			bookmarks[i], bookmarks[j] = bookmarks[j], bookmarks[i]
		}
	}
	var HasLeft = true
	if /*!(direction == right && offset != 0 && len(bookmarks) == config.BookmarksPageSize) && */ offset == math.MaxInt64 || (direction == domain.DirectionLeft && !moreResultsLeft) {
		HasLeft = false
	}
	var LeftOffset int64 = 0
	if len(bookmarks) > 0 {
		LeftOffset = bookmarks[0].Created.Unix()
	}
	var HasRight = true
	if /* !(direction == left && offset != 0 && len(bookmarks) == config.BookmarksPageSize) && */ offset == 0 || (direction == domain.DirectionRight && !moreResultsLeft) {
		HasRight = false
	}
	var RightOffset int64 = math.MaxInt64
	if len(bookmarks) >= controller.Config.BookmarksPageSize {
		RightOffset = bookmarks[controller.Config.BookmarksPageSize-1].Created.Unix()
	}

	feedId, err := controller.Store.GetOrCreateFeedIdForUser(userid)
	if err != nil {
		controller.handleInternalServerError(w, err)
		return
	}

	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Last-Modified", currentLastModifiedDateTime.Format(http.TimeFormat))
	controller.render(w, http.StatusOK, "bookmarks", domain.BookmarkSlice{
		Bookmarks:   bookmarks,
		HasLeft:     HasLeft,
		LeftOffset:  LeftOffset,
		HasRight:    HasRight,
		RightOffset: RightOffset,
		SearchQuery: searchQuery,
		RssFeedUrl:  controller.Config.DeliciousBookmarksBaseUrl + "/feeds/" + feedId})
}

func (controller *Controller) showAddBookmark(w http.ResponseWriter, r *http.Request) {
	userid, err := controller.userId(r)
	if err != nil {
		controller.handleInternalServerError(w, err)
		return
	}
	query := r.URL.Query()
	url := query.Get("url")
	title := query.Get("title")
	description := query.Get("description")
	if url != "" {
		existingBookmark, err := controller.Store.FindExistingBookmark(url, userid)
		if err != nil {
			controller.handleInternalServerError(w, err)
			return
		}
		if existingBookmark != (domain.Bookmark{}) {
			controller.render(w, http.StatusOK, "addbookmark", AddBookmarkPage{Bookmark: existingBookmark})
			return
		}
	}
	controller.render(w, http.StatusOK, "addbookmark", AddBookmarkPage{Bookmark: domain.Bookmark{URL: url, Title: title, Description: description}})
}

func (controller *Controller) deleteBookmark(w http.ResponseWriter, r *http.Request) {
	userid, err := controller.userId(r)
	if err != nil {
		controller.handleInternalServerError(w, err)
		return
	}
	url := r.FormValue("url")
	if url != "" {
		err := controller.Store.DeleteBookmark(url, userid)
		if err != nil {
			controller.handleInternalServerError(w, err)
			return
		}
	}
	http.Redirect(w, r, "/bookmarks", http.StatusFound)
}

func (controller *Controller) addBookmark(w http.ResponseWriter, r *http.Request) {
	userid, err := controller.userId(r)
	if err != nil {
		controller.handleInternalServerError(w, err)
		return
	}
	url := r.FormValue("url")
	if url == "" {
		controller.render(w, http.StatusBadRequest, "error-badrequest", "url parameter is required")
		return
	}
	title := r.FormValue("title")
	description := r.FormValue("description")
	tags := r.FormValue("tags")
	private := r.FormValue("private") == "on"
	readlater := r.FormValue("readlater") == "on"
	err = controller.Store.AddOrUpdateBookmark(domain.Bookmark{URL: url, Title: title, Description: description, Tags: tags, Private: private, Readlater: readlater}, userid)
	if err != nil {
		controller.handleInternalServerError(w, err)
		return
	}
	http.Redirect(w, r, "/bookmarks", http.StatusFound)
}

func (controller *Controller) showFeed(w http.ResponseWriter, r *http.Request) {
	feedId := r.PathValue("id")
	userId, err := controller.Store.FindUserIdForFeedId(feedId)
	if err != nil {
		slog.Info("Feed not found", "feedId", feedId, "err", err)
		// this is not entirely correct, we are returning 404 for all errors, but we may
		// also get a random database error, and we do not cleanly distinguish between
		// those and not finding the ID
		http.Error(w, "feed with id "+feedId+" not found", http.StatusNotFound)
		return
	}
	readLaterBookmarks, err := controller.Store.FindReadLaterBookmarksWithContent(userId, controller.Config.MaxContentDownloadAttempts)
	if err != nil {
		controller.handleInternalServerError(w, err)
		return
	}
	feed := &feeds.Feed{
		Title:       "Delicious Read Later Bookmarks",
		Link:        &feeds.Link{Href: controller.Config.DeliciousBookmarksBaseUrl + "/feeds/" + feedId},
		Description: "RSS feed generated of all your delicious bookmarks marked as read later.",
		Created:     time.Now(),
	}

	for _, readLaterBookmark := range readLaterBookmarks {
		if readLaterBookmark.SuccessfullyRetrieved {
			contentTypeIsHtml := readLaterBookmark.ContentType == "" || strings.Contains(readLaterBookmark.ContentType, "text/html")
			item := &feeds.Item{
				Title:   readLaterBookmark.Title,
				Link:    &feeds.Link{Href: readLaterBookmark.Url},
				Content: lang.IfElse(contentTypeIsHtml, readLaterBookmark.Content, "Content is not HTML."),
				Id:      readLaterBookmark.Url + "#" + strconv.FormatInt(readLaterBookmark.RetrievalTime.Unix(), 10),
				Author:  &feeds.Author{Name: readLaterBookmark.Byline},
				Created: readLaterBookmark.RetrievalTime,
			}
			feed.Add(item)
		}
	}

	rss, err := feed.ToRss()
	if err != nil {
		controller.handleInternalServerError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/rss+xml")
	_, _ = w.Write([]byte(rss))
}
