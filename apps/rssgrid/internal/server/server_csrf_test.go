package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	baseliboidc "github.com/aggregat4/a4s/pkg/auth/oidc"
	"github.com/aggregat4/a4s/pkg/testing/oidcmock"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// loggedInHandler returns the full handler, with its login, and the cookie
// of a logged-in user.
func loggedInHandler(t *testing.T, store *mockStore) (http.Handler, *http.Cookie) {
	t.Helper()
	idp, err := oidcmock.Run("rssgrid", "secret", "http://rssgrid.example/auth/callback", nil, "")
	require.NoError(t, err)
	t.Cleanup(idp.Close)
	oidcConfig := baseliboidc.CreateOidcConfiguration(idp.Issuer(), "rssgrid", "secret", "http://rssgrid.example/auth/callback")
	srv, err := NewServer(store, oidcConfig, "test-session-key-at-least-32-bytes!!", false)
	require.NoError(t, err)

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	w := httptest.NewRecorder()
	session, _ := srv.sessions.Get(req, "user_session")
	session.Values["user_id"] = int64(1)
	require.NoError(t, session.Save(req, w))
	cookies := w.Result().Cookies()
	require.NotEmpty(t, cookies)
	return srv.Handler(), cookies[0]
}

func postPreferences(handler http.Handler, cookie *http.Cookie, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "http://rssgrid.example/settings/preferences", strings.NewReader("postsPerFeed=20&columns=3"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.AddCookie(cookie)
	for name, value := range headers {
		req.Header.Set(name, value)
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	return w
}

func TestCrossOriginPostsAreRejected(t *testing.T) {
	for name, headers := range map[string]map[string]string{
		"a cross-site page":                   {"Sec-Fetch-Site": "cross-site"},
		"another site without fetch metadata": {"Origin": "https://evil.example"},
		"another port on the same host":       {"Origin": "http://rssgrid.example:8080"},
	} {
		t.Run(name, func(t *testing.T) {
			store := mockStoreEmpty()
			handler, cookie := loggedInHandler(t, store)
			w := postPreferences(handler, cookie, headers)
			assert.Equal(t, http.StatusForbidden, w.Code)
			assert.False(t, store.preferencesSet)
		})
	}
}

func TestSameOriginPostsAreAccepted(t *testing.T) {
	for name, headers := range map[string]map[string]string{
		"a page of the app":                 {"Sec-Fetch-Site": "same-origin"},
		"the app's origin without metadata": {"Origin": "http://rssgrid.example"},
	} {
		t.Run(name, func(t *testing.T) {
			store := mockStoreEmpty()
			handler, cookie := loggedInHandler(t, store)
			w := postPreferences(handler, cookie, headers)
			assert.Equal(t, http.StatusSeeOther, w.Code)
			assert.True(t, store.preferencesSet)
		})
	}
}
