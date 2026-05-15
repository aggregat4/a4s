package oidcmock

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestMockOidcAuthorizationCodeFlow(t *testing.T) {
	m, err := Run("test-client", "test-secret", "http://localhost:8080/oidccallback", map[string]any{
		"roles": []string{"admin-demo", "superadmin"},
	}, "")
	require.NoError(t, err)
	defer m.Close()

	// 1. Discovery document is reachable and well-formed
	discoRes, err := http.Get(m.Issuer() + "/.well-known/openid-configuration")
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, discoRes.StatusCode)

	var disco map[string]string
	require.NoError(t, json.NewDecoder(discoRes.Body).Decode(&disco))
	require.Equal(t, m.Issuer(), disco["issuer"])
	require.NotEmpty(t, disco["authorization_endpoint"])
	require.NotEmpty(t, disco["token_endpoint"])
	require.NotEmpty(t, disco["jwks_uri"])

	// 2. Unauthenticated request to protected resource redirects to auth endpoint
	authURL, err := url.Parse(disco["authorization_endpoint"])
	require.NoError(t, err)
	q := authURL.Query()
	q.Set("client_id", "test-client")
	q.Set("redirect_uri", "http://localhost:8080/oidccallback")
	q.Set("response_type", "code")
	q.Set("scope", "openid")
	q.Set("state", "some-state")
	authURL.RawQuery = q.Encode()

	client := &http.Client{CheckRedirect: func(req *http.Request, via []*http.Request) error { return http.ErrUseLastResponse }}
	authRes, err := client.Get(authURL.String())
	require.NoError(t, err)
	require.Equal(t, http.StatusFound, authRes.StatusCode)

	redirect := authRes.Header.Get("Location")
	require.Contains(t, redirect, "http://localhost:8080/oidccallback?code=")
	require.Contains(t, redirect, "state=some-state")

	// 3. Exchange code for tokens
	parsedRedirect, err := url.Parse(redirect)
	require.NoError(t, err)
	code := parsedRedirect.Query().Get("code")
	require.NotEmpty(t, code)

	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("code", code)
	form.Set("redirect_uri", "http://localhost:8080/oidccallback")
	form.Set("client_id", "test-client")
	form.Set("client_secret", "test-secret")

	tokenRes, err := http.Post(disco["token_endpoint"], "application/x-www-form-urlencoded", strings.NewReader(form.Encode()))
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, tokenRes.StatusCode)

	var tokenResp struct {
		IDToken string `json:"id_token"`
	}
	require.NoError(t, json.NewDecoder(tokenRes.Body).Decode(&tokenResp))
	require.NotEmpty(t, tokenResp.IDToken)

	// 4. JWKS is reachable
	jwksRes, err := http.Get(disco["jwks_uri"])
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, jwksRes.StatusCode)
}
