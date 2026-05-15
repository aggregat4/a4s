package server

import (
	"net/http"
	"testing"

	"aggregat4/go-commentservice/internal/testing/oidcmock"

	"github.com/stretchr/testify/require"
)

func TestOidcCallbackCreatesUserSession(t *testing.T) {
	idp, err := oidcmock.Run(
		"commentservice-client",
		"commentservice-secret",
		"http://localhost:8080/oidccallback",
		map[string]any{"roles": []string{"admin-TESTSERVICE"}},
		"",
	)
	require.NoError(t, err)
	defer idp.Close()

	h := NewServerHarness(t, WithOidc(idp))
	idpClient := h.IdpClient()

	var jar []*http.Cookie

	// Step 1: unauthenticated request to /admin triggers OIDC redirect
	adminRes := h.ExecRequest(http.MethodGet, h.BaseURL+"/admin", "", jar)
	require.Equal(t, http.StatusFound, adminRes.StatusCode)
	authLocation := adminRes.Header.Get("Location")
	require.Contains(t, authLocation, idp.Issuer())
	jar = append(jar, adminRes.Cookies()...)

	// Step 2: follow OIDC auth redirect at the mock IdP
	authRes, err := idpClient.Get(authLocation)
	require.NoError(t, err)
	require.Equal(t, http.StatusFound, authRes.StatusCode)
	callbackLocation := authRes.Header.Get("Location")
	require.Contains(t, callbackLocation, "/oidccallback?code=")
	require.Contains(t, callbackLocation, "state=")

	// Step 3: follow callback — OIDC code exchange + session creation
	callbackRes := h.ExecRequest(http.MethodGet, callbackLocation, "", jar)
	require.Equal(t, http.StatusFound, callbackRes.StatusCode)
	require.Equal(t, h.BaseURL+"/admin", callbackRes.Header.Get("Location"))
	jar = append(jar, callbackRes.Cookies()...)

	// Step 4: with session cookie, /admin redirects to dashboard
	adminRes2 := h.ExecRequest(http.MethodGet, h.BaseURL+"/admin", "", jar)
	require.Equal(t, http.StatusFound, adminRes2.StatusCode)
	require.Equal(t, "/admin/comments", adminRes2.Header.Get("Location"))

	// Step 5: service admin dashboard is accessible
	dashRes := h.ExecRequest(http.MethodGet, h.BaseURL+"/admin/TESTSERVICE/comments", "", jar)
	require.Equal(t, http.StatusOK, dashRes.StatusCode)
}
