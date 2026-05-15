package oidcmock

import (
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"maps"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
)

// Server is a minimal OIDC provider for integration tests.
type Server struct {
	*httptest.Server
	mu           sync.Mutex
	privateKey   *rsa.PrivateKey
	jwkSet       jose.JSONWebKeySet
	clientID     string
	clientSecret string
	redirectURI  string
	codes        map[string]codeEntry
	claims       map[string]any
	host         string
}

type codeEntry struct {
	redirectURI string
	expires     time.Time
}

// Run starts a mock OIDC server on a random port.
// The caller should call Shutdown() when done.
// If host is non-empty the server listens on all interfaces so it is reachable
// from other machines on the network, and Issuer() returns a URL using that host.
func Run(clientID, clientSecret, redirectURI string, claims map[string]any, host string) (*Server, error) {
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, fmt.Errorf("generate rsa key: %w", err)
	}

	m := &Server{
		privateKey:   priv,
		clientID:     clientID,
		clientSecret: clientSecret,
		redirectURI:  redirectURI,
		codes:        make(map[string]codeEntry),
		claims:       claims,
		host:         host,
		jwkSet: jose.JSONWebKeySet{
			Keys: []jose.JSONWebKey{
				{Key: &priv.PublicKey, Use: "sig", Algorithm: string(jose.RS256), KeyID: "mock-key-1"},
			},
		},
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/openid-configuration", m.discovery)
	mux.HandleFunc("/auth", m.authorize)
	mux.HandleFunc("/token", m.token)
	mux.HandleFunc("/jwks", m.jwks)

	if host != "" {
		l, err := net.Listen("tcp", "0.0.0.0:0")
		if err != nil {
			return nil, fmt.Errorf("listen on all interfaces: %w", err)
		}
		m.Server = httptest.NewUnstartedServer(mux)
		m.Server.Listener = l
		m.Server.Start()
		_, port, err := net.SplitHostPort(m.Server.Listener.Addr().String())
		if err != nil {
			return nil, fmt.Errorf("get listener port: %w", err)
		}
		m.Server.URL = "http://" + net.JoinHostPort(host, port)
	} else {
		m.Server = httptest.NewServer(mux)
	}
	return m, nil
}

func (m *Server) Issuer() string {
	if m.host != "" {
		return m.URL
	}
	// Use localhost instead of 127.0.0.1 so the mock IdP is same-site
	// with the application (which typically runs on localhost). This avoids
	// browsers treating the redirect back from the IdP as cross-site.
	return strings.Replace(m.URL, "127.0.0.1", "localhost", 1)
}

func (m *Server) SetRedirectURI(uri string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.redirectURI = uri
}

func (m *Server) discovery(w http.ResponseWriter, r *http.Request) {
	_ = json.NewEncoder(w).Encode(map[string]string{
		"issuer":                m.Issuer(),
		"authorization_endpoint": m.Issuer() + "/auth",
		"token_endpoint":        m.Issuer() + "/token",
		"jwks_uri":              m.Issuer() + "/jwks",
	})
}

func (m *Server) authorize(w http.ResponseWriter, r *http.Request) {
	if r.URL.Query().Get("client_id") != m.clientID {
		http.Error(w, "invalid client_id", http.StatusBadRequest)
		return
	}
	if r.URL.Query().Get("redirect_uri") != m.redirectURI {
		http.Error(w, "invalid redirect_uri", http.StatusBadRequest)
		return
	}
	if r.URL.Query().Get("response_type") != "code" {
		http.Error(w, "unsupported response_type", http.StatusBadRequest)
		return
	}

	code := randomString(32)
	m.mu.Lock()
	m.codes[code] = codeEntry{redirectURI: r.URL.Query().Get("redirect_uri"), expires: time.Now().Add(5 * time.Minute)}
	m.mu.Unlock()

	q := url.Values{}
	q.Set("code", code)
	q.Set("state", r.URL.Query().Get("state"))
	http.Redirect(w, r, r.URL.Query().Get("redirect_uri")+"?"+q.Encode(), http.StatusFound) //nolint:gosec // OIDC mock: redirect_uri is validated against registered value
}

func (m *Server) token(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if r.PostFormValue("grant_type") != "authorization_code" {
		http.Error(w, "unsupported grant_type", http.StatusBadRequest)
		return
	}

	// Validate client credentials via Basic Auth or POST body
	clientID, clientSecret, ok := r.BasicAuth()
	if !ok {
		clientID = r.PostFormValue("client_id")
		clientSecret = r.PostFormValue("client_secret")
	}
	if clientID != m.clientID || clientSecret != m.clientSecret {
		http.Error(w, "invalid client credentials", http.StatusUnauthorized)
		return
	}

	code := r.PostFormValue("code")
	m.mu.Lock()
	entry, ok := m.codes[code]
	m.mu.Unlock()

	if !ok || time.Now().After(entry.expires) {
		http.Error(w, "invalid code", http.StatusBadRequest)
		return
	}
	if r.PostFormValue("redirect_uri") != entry.redirectURI {
		http.Error(w, "invalid redirect_uri", http.StatusBadRequest)
		return
	}

	signer, err := jose.NewSigner(
		jose.SigningKey{Algorithm: jose.RS256, Key: m.privateKey},
		(&jose.SignerOptions{}).WithType("JWT").WithHeader("kid", "mock-key-1"),
	)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	now := time.Now()
	idClaims := map[string]any{
		"iss": m.Issuer(),
		"sub": "mock-user",
		"aud": m.clientID,
		"iat": jwt.NewNumericDate(now),
		"exp": jwt.NewNumericDate(now.Add(time.Hour)),
	}
	maps.Copy(idClaims, m.claims)

	idToken, err := jwt.Signed(signer).Claims(idClaims).Serialize()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"access_token": randomString(32),
		"token_type":   "Bearer",
		"expires_in":   3600,
		"id_token":     idToken,
	})
}

func (m *Server) jwks(w http.ResponseWriter, r *http.Request) {
	_ = json.NewEncoder(w).Encode(m.jwkSet)
}

func randomString(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)[:n]
}
