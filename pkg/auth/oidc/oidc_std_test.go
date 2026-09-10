package oidc

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/aggregat4/a4s/pkg/testing/oidcmock"
	"github.com/stretchr/testify/require"
)

func TestMiddlewareReusesInFlightStateCookie(t *testing.T) {
	idp, err := oidcmock.Run("client", "secret", "http://127.0.0.1/callback", nil, "")
	require.NoError(t, err)
	defer idp.Close()

	cfg := CreateOidcConfiguration(idp.Issuer(), "client", "secret", "http://127.0.0.1/callback")
	neverAuthenticated := func(r *http.Request) bool { return false }
	neverSkipped := func(r *http.Request) bool { return false }
	handler := cfg.CreateOidcAuthenticationMiddleware(neverAuthenticated, neverSkipped)(
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
		}),
	)

	first := httptest.NewRecorder()
	handler.ServeHTTP(first, httptest.NewRequest(http.MethodGet, "/first", nil))
	require.Equal(t, http.StatusFound, first.Code)

	cookies := first.Result().Cookies()
	require.Len(t, cookies, 1)
	stateCookie := cookies[0]
	require.Equal(t, oidcStateCookieName, stateCookie.Name)

	firstState := stateFromLocation(t, first)
	require.Equal(t, stateCookie.Value, firstState)

	// A second unauthenticated request (for example a static asset requested
	// while the user is still at the identity provider) must not rotate the
	// in-flight state cookie.
	second := httptest.NewRecorder()
	secondRequest := httptest.NewRequest(http.MethodGet, "/second", nil)
	secondRequest.AddCookie(stateCookie)
	handler.ServeHTTP(second, secondRequest)
	require.Equal(t, http.StatusFound, second.Code)
	require.Empty(t, second.Result().Cookies())
	require.Equal(t, firstState, stateFromLocation(t, second))
}

func stateFromLocation(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()

	location := rec.Header().Get("Location")
	require.NotEmpty(t, location)

	parsed, err := url.Parse(location)
	require.NoError(t, err)
	state := parsed.Query().Get("state")
	require.NotEmpty(t, state)
	return state
}
