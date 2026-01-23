package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"prototype-lists/server/internal/httpapi"
	"prototype-lists/server/internal/storage"
)

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
	defer store.Close()

	if err := store.Init(context.Background()); err != nil {
		log.Fatalf("storage init error: %v", err)
	}

	mux := http.NewServeMux()
	serverAPI := httpapi.NewServer(store)
	serverAPI.RegisterRoutes(mux)

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
