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
	"time"

	"prototype-lists/server/internal/httpapi"
	"prototype-lists/server/internal/storage"
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

	mux := http.NewServeMux()
	serverAPI := httpapi.NewServer(store)
	serverAPI.RegisterRoutes(mux)
	registerStatic(mux)

	server := &http.Server{
		Addr:              addr,
		Handler:           mux,
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
