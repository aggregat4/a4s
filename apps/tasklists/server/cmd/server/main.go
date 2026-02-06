package main

import (
	"context"
	"embed"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"a4-tasklists/server/internal/auth"
	"a4-tasklists/server/internal/httpapi"
	"a4-tasklists/server/internal/storage"

	baselibmiddleware "github.com/aggregat4/go-baselib-services/v4/middleware"
)

//go:embed all:static
var staticFS embed.FS

func main() {
	addr := ":8080"
	if port := os.Getenv("PORT"); port != "" {
		addr = ":" + port
	}

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

	serverAPI := httpapi.NewServer(store)
	serverAPI.RegisterRoutes(mux)
	registerStatic(mux)

	skipAuthPaths := map[string]struct{}{
		"/auth/login":    {},
		"/auth/callback": {},
		"/auth/logout":   {},
		"/healthz":       {},
	}
	authSkipper := func(r *http.Request) bool {
		if strings.HasPrefix(r.URL.Path, "/sync/") {
			return true
		}
		_, ok := skipAuthPaths[r.URL.Path]
		return ok
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

func registerStatic(mux *http.ServeMux) {
	// Priority 1: External static directory (for development or custom builds)
	staticDir := os.Getenv("SERVER_STATIC_DIR")
	if staticDir != "" {
		registerStaticDir(mux, staticDir)
		return
	}

	// Priority 2: Try embedded static files (for packaged binary)
	if embeddedSub, err := fs.Sub(staticFS, "static"); err == nil {
		if _, err := embeddedSub.Open("index.html"); err == nil {
			registerEmbeddedFS(mux, embeddedSub)
			log.Printf("serving embedded static files")
			return
		}
	}

	log.Printf("warning: no static files found (set SERVER_STATIC_DIR or build with embedded files)")
}

func registerStaticDir(mux *http.ServeMux, staticDir string) {
	fileServer := http.FileServer(http.Dir(staticDir))
	mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := filepath.Join(staticDir, filepath.Clean(r.URL.Path))
		if _, err := os.Stat(path); err == nil {
			fileServer.ServeHTTP(w, r)
			return
		}
		http.ServeFile(w, r, filepath.Join(staticDir, "index.html"))
	}))
	log.Printf("serving static files from %s", staticDir)
}

func registerEmbeddedFS(mux *http.ServeMux, staticSub fs.FS) {
	fileServer := http.FileServer(http.FS(staticSub))
	mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := filepath.Clean(r.URL.Path)
		if path == "/" {
			path = "/index.html"
		}
		if _, err := staticSub.Open(path); err == nil {
			fileServer.ServeHTTP(w, r)
			return
		}
		// Fallback to index.html for SPA routing
		serveIndexFallback(w, r, staticSub)
	}))
}

func serveIndexFallback(w http.ResponseWriter, r *http.Request, fs fs.FS) {
	idx, err := fs.Open("index.html")
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer func() { _ = idx.Close() }()

	content, err := io.ReadAll(idx)
	if err != nil {
		http.Error(w, "Error reading index.html", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if _, err := w.Write(content); err != nil {
		log.Printf("error writing index.html: %v", err)
	}
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
