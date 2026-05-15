package main

import (
	"aggregat4/go-commentservice/internal/domain"
	"aggregat4/go-commentservice/internal/repository"
	"aggregat4/go-commentservice/internal/server"
	"aggregat4/go-commentservice/internal/testing/oidcmock"
	"context"
	"crypto/rand"
	"encoding/hex"
	"io"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/aggregat4/go-baselib/crypto"
	"github.com/willibrandon/mtlog"
	"github.com/willibrandon/mtlog/core"

	_ "github.com/mattn/go-sqlite3"
)

var logger = mtlog.New(
	mtlog.WithConsole(),
	mtlog.WithMinimumLevel(core.InformationLevel),
)

func main() {
	// Generate a fresh demo encryption key for this process only.
	// In a real deployment this would come from a secret manager.
	encryptionKey := mustGenerateKey()

	demoHost := os.Getenv("DEMO_HOST")
	if demoHost == "" {
		demoHost = "localhost"
	}
	baseURL := "http://" + demoHost + ":8080"

	// Start a mock OIDC provider so the demo works without an external IdP.
	idp, err := oidcmock.Run(
		"commentservice-client",
		"commentservice-secret",
		baseURL+"/oidccallback",
		map[string]any{
			"roles": []string{"admin-demoservice", "superadmin"},
		},
		demoHost,
	)
	if err != nil {
		panic(err)
	}
	defer idp.Close()

	logger.Info("Mock OIDC provider running at {issuer}", idp.Issuer())

	secretKey, err := hex.DecodeString(encryptionKey)
	if err != nil {
		panic(err)
	}
	aesCipher, err := crypto.CreateAes256GcmAead(secretKey)
	if err != nil {
		panic(err)
	}

	store := repository.Store{Cipher: aesCipher}
	defer store.Close()

	if err := store.InitAndVerifyDb(repository.CreateInMemoryDbUrl()); err != nil {
		logger.Fatal("Error initializing database {err}", err)
		os.Exit(1)
	}

	// Seed the demo service if it doesn't already exist.
	if _, err := store.GetServiceForKey("demoservice"); err != nil {
		if _, err := store.CreateService("demoservice", baseURL); err != nil {
			logger.Fatal("Error creating demo service {err}", err)
			os.Exit(1)
		}
		logger.Info("Created demo service: demoservice")
	}

	config := domain.Config{ //nolint:gosec // Demo credentials
		Port:                        8080,
		DatabaseFilename:            "in-memory-demo",
		BaseURL:                     baseURL,
		ServerReadTimeoutSeconds:    5,
		ServerWriteTimeoutSeconds:   10,
		OidcIdpServer:               idp.Issuer(),
		OidcClientId:                "commentservice-client",
		OidcClientSecret:            "commentservice-secret",
		OidcRedirectUri:             baseURL + "/oidccallback",
		EncryptionKey:               encryptionKey,
		SessionCookieSecretKey:      "demosessionssecretkey32byteslong",
		SessionCookieSecureFlag:     false,
		SessionCookieCookieMaxAge:   2592000,
		SessionCookieCookieSameSite: "lax",
	}

	controller := server.Controller{
		Store:  &store,
		Config: config,
	}

	httpServer := server.RunServer(&controller)

	logger.Info("")
	logger.Info("=== Comment Service Demo ===")
	logger.Info("Demo page:       {baseURL}/demo", baseURL)
	logger.Info("Admin dashboard: {baseURL}/admin", baseURL)
	logger.Info("Comments iframe: {baseURL}/services/demoservice/posts/demopost/comments/", baseURL)
	logger.Info("")
	logger.Info("The mock OIDC provider auto-authenticates anyone who clicks 'Login'.")
	logger.Info("Press Ctrl+C to stop.")
	logger.Info("")

	shutdownSignals := make(chan os.Signal, 1)
	signal.Notify(shutdownSignals, syscall.SIGINT, syscall.SIGTERM)

	sig := <-shutdownSignals
	logger.Info("Shutdown signal received {signal}", sig)
	signal.Stop(shutdownSignals)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := httpServer.Shutdown(ctx); err != nil {
		logger.Error("Graceful shutdown failed {err}", err)
		_ = httpServer.Close()
	} else {
		logger.Info("HTTP server shut down gracefully")
	}
}

func mustGenerateKey() string {
	key := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, key); err != nil {
		panic(err)
	}
	return hex.EncodeToString(key)
}
