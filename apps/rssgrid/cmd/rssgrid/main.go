package main

import (
	"context"
	"flag"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/aggregat4/a4s/apps/rssgrid/internal/config"
	"github.com/aggregat4/a4s/apps/rssgrid/internal/db"
	"github.com/aggregat4/a4s/apps/rssgrid/internal/feed"
	"github.com/aggregat4/a4s/apps/rssgrid/internal/server"
	baseliboidc "github.com/aggregat4/a4s/pkg/auth/oidc"
)

func main() {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, nil)))

	var configPath string
	flag.StringVar(&configPath, "config", "", "Path to configuration file (default: ~/.config/rssgrid/rssgrid.json)")
	flag.Parse()

	var cfg *config.Config
	var err error

	if configPath != "" {
		cfg, err = config.LoadWithPath(configPath)
	} else {
		cfg, err = config.Load()
	}

	if err != nil {
		fatal("Error loading configuration", err)
	}

	store, err := db.NewStore(cfg.DBPath)
	if err != nil {
		fatal("Error initializing database", err)
	}

	if err := cfg.Validate(); err != nil {
		fatal("Invalid configuration", err)
	}

	oidcConfig := baseliboidc.CreateOidcConfiguration(
		cfg.OIDC.IssuerURL,
		cfg.OIDC.ClientID,
		cfg.OIDC.ClientSecret,
		cfg.OIDC.RedirectURL,
	)

	srv, err := server.NewServer(store, oidcConfig, cfg.SessionKey, cfg.SecureCookies)
	if err != nil {
		fatal("Error initializing server", err)
	}

	updater := feed.NewUpdater(store, cfg.UpdateInterval, cfg.MaxPostsPerFeed)

	// Create context that will be canceled on shutdown
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	updater.Start(ctx)

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		<-sigChan
		slog.Info("Shutting down")
		cancel()
	}()

	serverErr := srv.StartWithContext(ctx, cfg.Addr)

	// Wait for an in-flight feed update to finish before closing the store.
	updater.Stop()
	if err := store.Close(); err != nil {
		slog.Error("Error closing database", "err", err)
	}

	if serverErr != nil {
		fatal("Error running server", serverErr)
	}
}

// fatal logs an error and exits with a non-zero status.
func fatal(msg string, err error) {
	slog.Error(msg, "err", err)
	os.Exit(1)
}
