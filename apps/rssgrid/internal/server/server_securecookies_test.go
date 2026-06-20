package server

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// newServerForCookieTest builds a Server with a real store and the given
// secure-cookies setting, without needing OIDC.
func newServerForCookieTest(t *testing.T, secureCookies bool) *Server {
	t.Helper()
	store, cleanup := createTestStore(t)
	t.Cleanup(cleanup)
	srv, err := NewServer(store, nil, "test-session-key-at-least-32-bytes!!", secureCookies)
	require.NoError(t, err)
	return srv
}

func TestNewServer_SecureCookiesFalse(t *testing.T) {
	srv := newServerForCookieTest(t, false)

	// Trigger a session save by issuing a request that writes a flash.
	req := httptest.NewRequest("GET", "/", nil)
	w := httptest.NewRecorder()
	srv.addSuccessFlash(w, req, "hello")

	cookies := w.Result().Cookies()
	var sessionCookie *http.Cookie
	for _, c := range cookies {
		if c.Name == "user_session" {
			sessionCookie = c
		}
	}
	require.NotNil(t, sessionCookie, "expected a user_session cookie to be set")
	assert.False(t, sessionCookie.Secure, "Secure should be false when SecureCookies is false")
	assert.True(t, sessionCookie.HttpOnly, "HttpOnly should always be true")
}

func TestNewServer_SecureCookiesTrue(t *testing.T) {
	srv := newServerForCookieTest(t, true)

	req := httptest.NewRequest("GET", "/", nil)
	w := httptest.NewRecorder()
	srv.addSuccessFlash(w, req, "hello")

	cookies := w.Result().Cookies()
	var sessionCookie *http.Cookie
	for _, c := range cookies {
		if c.Name == "user_session" {
			sessionCookie = c
		}
	}
	require.NotNil(t, sessionCookie, "expected a user_session cookie to be set")
	assert.True(t, sessionCookie.Secure, "Secure should be true when SecureCookies is true")
}

// TestNewServer_SessionStoreOptionsIsolated ensures the Secure flag reflects the
// configured value at the store level (defensive check independent of cookie
// serialization quirks).
func TestNewServer_SessionStoreOptionsIsolated(t *testing.T) {
	srv := newServerForCookieTest(t, true)

	// The cookie store's Options is set directly by NewServer.
	opts := srv.sessions.Options
	require.NotNil(t, opts)
	assert.True(t, opts.Secure)
	assert.Equal(t, http.SameSiteLaxMode, opts.SameSite)
	assert.True(t, opts.HttpOnly)
}
