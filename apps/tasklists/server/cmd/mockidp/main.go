// Command mockidp runs the in-repo mock OpenID Provider used by the Tasklists
// browser end-to-end tests. It is not part of the deployed server.
package main

import (
	"log"
	"os"

	"github.com/aggregat4/a4s/pkg/testing/oidcmock"
)

func main() {
	listenAddr := envOrDefault("IDP_LISTEN_ADDR", "0.0.0.0:8001")
	issuerURL := envOrDefault("IDP_ISSUER_URL", "http://127.0.0.1:8001")
	clientID := envOrDefault("IDP_CLIENT_ID", "tasklists")
	clientSecret := envOrDefault("IDP_CLIENT_SECRET", "tasklists-secret")
	redirectURI := envOrDefault("IDP_REDIRECT_URI", "http://127.0.0.1:8000/auth/callback")

	if _, err := oidcmock.RunAt(listenAddr, issuerURL, clientID, clientSecret, redirectURI, nil); err != nil {
		log.Fatalf("mock idp error: %v", err)
	}

	log.Printf("mock idp listening on %s (issuer %s)", listenAddr, issuerURL)
	select {}
}

func envOrDefault(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
