package main

import (
	"context"
	"flag"
	"log"
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
		log.Fatalf("Error loading configuration: %v", err)
	}

	store, err := db.NewStore(cfg.DBPath)
	if err != nil {
		log.Fatalf("Error initializing database: %v", err)
	}

	if err := cfg.Validate(); err != nil {
		log.Fatalf("Invalid configuration: %v", err)
	}

	oidcConfig := baseliboidc.CreateOidcConfiguration(
		cfg.OIDC.IssuerURL,
		cfg.OIDC.ClientID,
		cfg.OIDC.ClientSecret,
		cfg.OIDC.RedirectURL,
	)

	srv, err := server.NewServer(store, oidcConfig, cfg.SessionKey, cfg.SecureCookies)
	if err != nil {
		log.Fatalf("Error initializing server: %v", err)
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
		log.Println("Shutting down...")
		cancel()
		updater.Stop()
	}()

	if err := srv.StartWithContext(ctx, cfg.Addr); err != nil {
		log.Fatalf("Error starting server: %v", err)
	}
}
