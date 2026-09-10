package main

import (
	"context"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/aggregat4/a4s/apps/tasklists/server/internal/auth"
	"github.com/aggregat4/a4s/apps/tasklists/server/internal/httpapi"
	"github.com/aggregat4/a4s/apps/tasklists/server/internal/storage"

	baselibmiddleware "github.com/aggregat4/a4s/pkg/http/middleware"
)

//go:embed all:static
var staticFS embed.FS

var version = "dev"

var requiredStaticAssets = []string{
	"index.html",
	"styles.css",
	"manifest.json",
	"sw.js",
	"entrypoints/main.js",
	"icons/icon-192.png",
	"icons/icon-512.png",
	"icons/apple-touch-icon.png",
}

func main() {
	addr := ":8080"
	if port := os.Getenv("PORT"); port != "" {
		addr = ":" + port
	}

	log.Printf("starting tasklists version=%s", version)

	dbPath := os.Getenv("SERVER_DB_PATH")
	if dbPath == "" {
		dbPath = "data.db"
	}
	if err := ensureParentDir(dbPath); err != nil {
		log.Fatalf("db path error: %v", err)
	}
	store, err := storage.OpenSQLite(dbPath)
	if err != nil {
		log.Fatalf("storage error: %v", err)
	}
	defer func() {
		if err := store.Close(); err != nil {
			log.Printf("error closing store: %v", err)
		}
	}()

	if err := store.Init(context.Background()); err != nil {
		log.Fatalf("storage init error: %v", err)
	}

	issuerURL := os.Getenv("OIDC_ISSUER_URL")
	clientID := os.Getenv("OIDC_CLIENT_ID")
	clientSecret := os.Getenv("OIDC_CLIENT_SECRET")
	redirectURL := os.Getenv("OIDC_REDIRECT_URL")
	sessionKey := os.Getenv("SERVER_SESSION_KEY")
	cookieSecure := envBoolDefault("SERVER_COOKIE_SECURE", true)
	cookieDomain := os.Getenv("SERVER_COOKIE_DOMAIN")
	authMode := strings.ToLower(strings.TrimSpace(os.Getenv("SERVER_AUTH_MODE")))
	devUserID := os.Getenv("SERVER_DEV_USER_ID")

	var authManager *auth.Manager
	if authMode != "dev" {
		if issuerURL == "" || clientID == "" || redirectURL == "" {
			log.Fatalf("oidc config error: OIDC_ISSUER_URL, OIDC_CLIENT_ID, and OIDC_REDIRECT_URL are required unless SERVER_AUTH_MODE=dev")
		}
		var err error
		authManager, err = auth.NewManager(auth.Config{
			IssuerURL:      issuerURL,
			ClientID:       clientID,
			ClientSecret:   clientSecret,
			RedirectURL:    redirectURL,
			SessionKey:     sessionKey,
			SessionTTL:     30 * 24 * time.Hour,
			CookieSecure:   cookieSecure,
			CookieSameSite: http.SameSiteLaxMode,
			CookieDomain:   cookieDomain,
			FallbackURL:    "/",
		})
		if err != nil {
			log.Fatalf("auth config error: %v", err)
		}
	}

	mux := http.NewServeMux()
	if authManager != nil {
		mux.Handle("/auth/login", authManager.LoginHandler())
		mux.Handle("/auth/callback", authManager.CallbackHandler())
		mux.Handle("/auth/logout", authManager.LogoutHandler())
	} else {
		mux.HandleFunc("/auth/login", func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodGet {
				w.WriteHeader(http.StatusMethodNotAllowed)
				return
			}
			http.Redirect(w, r, "/", http.StatusFound)
		})
		mux.HandleFunc("/auth/logout", func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				w.WriteHeader(http.StatusMethodNotAllowed)
				return
			}
			w.WriteHeader(http.StatusNoContent)
		})
	}

	broadcaster := httpapi.NewBroadcaster()
	serverAPI := httpapi.NewServer(store, broadcaster)
	serverAPI.RegisterRoutes(mux)
	if err := registerStatic(mux); err != nil {
		log.Fatalf("static asset error: %v", err)
	}

	// Only the application document is gated by OIDC. Static assets are public
	// and the sync API enforces its own session checks. Gating subresources
	// caused every asset request to mint a new oidc-callback-state-cookie,
	// which invalidated in-flight logins.
	authSkipper := func(r *http.Request) bool {
		return !requiresAuthentication(r.URL.Path)
	}

	handler := http.Handler(mux)
	if authMode == "dev" {
		handler = auth.DevUserMiddleware(devUserID)(handler)
	} else {
		handler = authManager.WithUser(handler)
		handler = baselibmiddleware.CsrfMiddlewareStd(handler)
		handler = authManager.OIDCMiddleware(authSkipper)(handler)
	}

	server := &http.Server{
		Addr:              addr,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
	}

	log.Printf("server listening on %s", addr)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("server error: %v", err)
	}
}

func ensureParentDir(path string) error {
	dir := filepath.Dir(path)
	if dir == "." || dir == "" {
		return nil
	}
	return os.MkdirAll(dir, 0o755)
}

func registerStatic(mux *http.ServeMux) error {
	// Priority 1: External static directory (for development or custom builds)
	staticDir := os.Getenv("SERVER_STATIC_DIR")
	if staticDir != "" {
		if err := validateStaticAssets(os.DirFS(staticDir)); err != nil {
			return err
		}
		registerStaticDir(mux, staticDir)
		return nil
	}

	// Priority 2: Try embedded static files (for packaged binary)
	if embeddedSub, err := fs.Sub(staticFS, "static"); err == nil {
		if err := validateStaticAssets(embeddedSub); err == nil {
			registerEmbeddedFS(mux, embeddedSub)
			log.Printf("serving embedded static files")
			return nil
		} else {
			return err
		}
	}

	return errors.New("no static assets found; set SERVER_STATIC_DIR or build with embedded assets")
}

func validateStaticAssets(staticFS fs.FS) error {
	for _, assetPath := range requiredStaticAssets {
		if _, err := fs.Stat(staticFS, assetPath); err != nil {
			return &missingStaticFileError{Path: assetPath, Err: err}
		}
	}
	return nil
}

type missingStaticFileError struct {
	Path string
	Err  error
}

func (e *missingStaticFileError) Error() string {
	return fmt.Sprintf("required static asset not found: %s", e.Path)
}

func (e *missingStaticFileError) Unwrap() error {
	return e.Err
}

func registerStaticDir(mux *http.ServeMux, staticDir string) {
	fileServer := cacheControlForStatic(http.FileServer(http.Dir(staticDir)))
	mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		lookupPath := staticLookupPath(r.URL.Path)
		fullPath := filepath.Join(staticDir, filepath.FromSlash(lookupPath))
		if _, err := os.Stat(fullPath); err == nil {
			fileServer.ServeHTTP(w, r)
			return
		}
		http.NotFound(w, r)
	}))
	log.Printf("serving static files from %s", staticDir)
}

func registerEmbeddedFS(mux *http.ServeMux, staticSub fs.FS) {
	fileServer := cacheControlForStatic(http.FileServer(http.FS(staticSub)))
	mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		lookupPath := staticLookupPath(r.URL.Path)
		if _, err := staticSub.Open(lookupPath); err == nil {
			fileServer.ServeHTTP(w, r)
			return
		}
		http.NotFound(w, r)
	}))
}

// cacheControlForStatic sets a cache policy per static asset. Hashed chunk
// names are immutable; the app shell and asset manifest are never cached;
// everything else must be revalidated.
func cacheControlForStatic(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", staticCacheControl(r.URL.Path))
		next.ServeHTTP(w, r)
	})
}

func staticCacheControl(requestPath string) string {
	switch {
	case strings.HasPrefix(requestPath, "/chunks/"):
		return "public, max-age=31536000, immutable"
	case requestPath == "/" || requestPath == "/index.html" || requestPath == "/asset-manifest.json":
		return "no-store"
	default:
		return "no-cache"
	}
}

// requiresAuthentication reports whether a request path must be behind the
// session based OIDC gate. Only the HTML application document is gated;
// static assets are public and sync endpoints perform their own checks.
func requiresAuthentication(requestPath string) bool {
	switch requestPath {
	case "/", "/index.html":
		return true
	default:
		return false
	}
}

func staticLookupPath(requestPath string) string {
	cleanPath := path.Clean("/" + strings.TrimSpace(requestPath))
	lookupPath := strings.TrimPrefix(cleanPath, "/")
	if lookupPath == "" || lookupPath == "." {
		return "index.html"
	}
	return lookupPath
}

func envBoolDefault(key string, defaultValue bool) bool {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return defaultValue
	}
	switch strings.ToLower(value) {
	case "1", "true", "yes", "y", "on":
		return true
	case "0", "false", "no", "n", "off":
		return false
	default:
		return defaultValue
	}
}
