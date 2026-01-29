package auth

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"net/http"
	"strings"
	"time"

	baseliboidc "github.com/aggregat4/go-baselib-services/v4/oidc"
	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/gorilla/sessions"
)

type contextKey string

const (
	userIDContextKey contextKey = "auth.user_id"
)

type Config struct {
	IssuerURL      string
	ClientID       string
	ClientSecret   string
	RedirectURL    string
	SessionKey     string
	SessionTTL     time.Duration
	CookieSecure   bool
	CookieSameSite http.SameSite
	CookieDomain   string
	FallbackURL    string
}

type Manager struct {
	oidcConfig    *baseliboidc.OidcConfiguration
	sessionStore  *sessions.CookieStore
	cookieOptions *sessions.Options
	fallbackURL   string
}

func NewManager(cfg Config) (*Manager, error) {
	if cfg.IssuerURL == "" || cfg.ClientID == "" || cfg.RedirectURL == "" {
		return nil, errors.New("oidc issuer, client id, and redirect url are required")
	}
	masterKey, err := parseSessionKey(cfg.SessionKey)
	if err != nil {
		return nil, err
	}
	hashKey, blockKey := deriveCookieKeys(masterKey)
	store := sessions.NewCookieStore(hashKey, blockKey)
	if cfg.SessionTTL == 0 {
		cfg.SessionTTL = 30 * 24 * time.Hour
	}
	if cfg.CookieSameSite == 0 {
		cfg.CookieSameSite = http.SameSiteLaxMode
	}
	options := &sessions.Options{
		Path:     "/",
		MaxAge:   int(cfg.SessionTTL.Seconds()),
		HttpOnly: true,
		Secure:   cfg.CookieSecure,
		SameSite: cfg.CookieSameSite,
		Domain:   cfg.CookieDomain,
	}
	store.Options = options
	store.MaxAge(options.MaxAge)

	return &Manager{
		oidcConfig:    baseliboidc.CreateOidcConfiguration(cfg.IssuerURL, cfg.ClientID, cfg.ClientSecret, cfg.RedirectURL),
		sessionStore:  store,
		cookieOptions: options,
		fallbackURL:   cfg.FallbackURL,
	}, nil
}

func (m *Manager) OIDCMiddleware(skipper func(r *http.Request) bool) func(http.Handler) http.Handler {
	return m.oidcConfig.CreateOidcAuthenticationMiddleware(m.IsAuthenticated, skipper)
}

func (m *Manager) CallbackHandler() http.Handler {
	delegate := baseliboidc.CreateSTDSessionBasedOidcDelegate(m.handleIDToken, m.fallbackURL)
	return m.oidcConfig.CreateOidcCallbackHandler(delegate)
}

func (m *Manager) LoginHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		http.Redirect(w, r, "/", http.StatusFound)
	}
}

func (m *Manager) LogoutHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		session, err := m.sessionStore.Get(r, baseliboidc.STDSessionCookieName)
		if err == nil {
			session.Options = cloneOptions(m.cookieOptions)
			session.Options.MaxAge = -1
			_ = session.Save(r, w)
		}
		http.Redirect(w, r, "/", http.StatusFound)
	}
}

func (m *Manager) WithUser(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		userID, _ := m.userIDFromSession(r)
		if userID != "" {
			ctx := context.WithValue(r.Context(), userIDContextKey, userID)
			r = r.WithContext(ctx)
		}
		next.ServeHTTP(w, r)
	})
}

func (m *Manager) IsAuthenticated(r *http.Request) bool {
	userID, _ := m.userIDFromSession(r)
	return userID != ""
}

func UserIDFromContext(ctx context.Context) (string, bool) {
	value := ctx.Value(userIDContextKey)
	userID, ok := value.(string)
	if !ok || userID == "" {
		return "", false
	}
	return userID, true
}

func ContextWithUserID(ctx context.Context, userID string) context.Context {
	return context.WithValue(ctx, userIDContextKey, userID)
}

func DevUserMiddleware(userID string) func(http.Handler) http.Handler {
	if userID == "" {
		userID = "dev-user"
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := ContextWithUserID(r.Context(), userID)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func (m *Manager) handleIDToken(w http.ResponseWriter, r *http.Request, idToken *oidc.IDToken) error {
	var claims struct {
		Subject string `json:"sub"`
	}
	if err := idToken.Claims(&claims); err != nil {
		return err
	}
	if claims.Subject == "" {
		return errors.New("id token missing sub claim")
	}
	session, err := m.sessionStore.Get(r, baseliboidc.STDSessionCookieName)
	if err != nil {
		return err
	}
	session.Options = cloneOptions(m.cookieOptions)
	session.Values["user_id"] = claims.Subject
	return session.Save(r, w)
}

func (m *Manager) userIDFromSession(r *http.Request) (string, bool) {
	session, err := m.sessionStore.Get(r, baseliboidc.STDSessionCookieName)
	if err != nil {
		return "", false
	}
	value, ok := session.Values["user_id"]
	if !ok {
		return "", false
	}
	userID, ok := value.(string)
	if !ok || userID == "" {
		return "", false
	}
	return userID, true
}

func parseSessionKey(raw string) ([]byte, error) {
	if raw == "" {
		key := make([]byte, 32)
		if _, err := rand.Read(key); err != nil {
			return nil, err
		}
		return key, nil
	}
	trimmed := strings.TrimSpace(raw)
	if decoded, err := base64.StdEncoding.DecodeString(trimmed); err == nil {
		if len(decoded) < 32 {
			return nil, errors.New("session key must decode to at least 32 bytes")
		}
		return decoded, nil
	}
	if len(trimmed) < 32 {
		return nil, errors.New("session key must be at least 32 characters or base64")
	}
	return []byte(trimmed), nil
}

func deriveCookieKeys(masterKey []byte) ([]byte, []byte) {
	hashKey := hmacSHA256(masterKey, []byte("auth"))
	blockKey := hmacSHA256(masterKey, []byte("enc"))
	return hashKey, blockKey
}

func hmacSHA256(key []byte, data []byte) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write(data)
	return mac.Sum(nil)
}

func cloneOptions(opts *sessions.Options) *sessions.Options {
	if opts == nil {
		return &sessions.Options{}
	}
	copy := *opts
	return &copy
}
