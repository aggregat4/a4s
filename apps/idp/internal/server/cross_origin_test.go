package server_test

import (
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func postWithHeaders(t *testing.T, path string, form url.Values, headers map[string]string) *http.Response {
	t.Helper()
	endpoint, err := createEndpointUrl(path)
	require.NoError(t, err)
	req, err := http.NewRequest(http.MethodPost, endpoint.String(), strings.NewReader(form.Encode()))
	require.NoError(t, err)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	for name, value := range headers {
		req.Header.Set(name, value)
	}
	res, err := createTestHttpClient().Do(req)
	require.NoError(t, err)
	res.Body.Close()
	return res
}

func TestFormPostsFromOtherOriginsAreRejected(t *testing.T) {
	httpServer, controller := waitForServer(t)
	defer cleanupTest(t, httpServer, controller)

	for name, headers := range map[string]map[string]string{
		"a cross-site page":             {"Sec-Fetch-Site": "cross-site"},
		"another site":                  {"Origin": "https://evil.example"},
		"another port on the same host": {"Origin": "http://localhost:1400"},
	} {
		t.Run(name, func(t *testing.T) {
			res := postWithHeaders(t, "/login", url.Values{"username": {TestUsername}, "password": {TestPassword}}, headers)
			assert.Equal(t, http.StatusForbidden, res.StatusCode)
		})
	}
}

func TestFormPostsFromTheProvidersOwnPagesAreAccepted(t *testing.T) {
	httpServer, controller := waitForServer(t)
	defer cleanupTest(t, httpServer, controller)

	res := postWithHeaders(t, "/login", url.Values{"username": {TestUsername}, "password": {TestPassword}}, map[string]string{"Sec-Fetch-Site": "same-origin"})
	assert.NotEqual(t, http.StatusForbidden, res.StatusCode)
}

// Relying parties call the token and revocation endpoints from their
// servers, so these are not checked for their origin; client
// authentication protects them instead.
func TestTokenAndRevocationEndpointsAcceptOtherOrigins(t *testing.T) {
	httpServer, controller := waitForServer(t)
	defer cleanupTest(t, httpServer, controller)

	crossSite := map[string]string{"Sec-Fetch-Site": "cross-site", "Origin": "https://relying-party.example"}
	for _, path := range []string{"/token", "/revoke"} {
		t.Run(path, func(t *testing.T) {
			res := postWithHeaders(t, path, url.Values{"grant_type": {"authorization_code"}, "token": {"irrelevant"}}, crossSite)
			assert.Equal(t, http.StatusUnauthorized, res.StatusCode, "client authentication, not the origin check, rejects it")
		})
	}
}
