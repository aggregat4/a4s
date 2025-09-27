package server

import (
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestAddCommentFormExposesLoginMetadata(t *testing.T) {
	h := NewServerHarness(t)
	client := h.NewClient(true)

	path := fmt.Sprintf(
		"/users/0/services/%s/posts/%s/commentform",
		h.Data.Service.ServiceKey,
		testPostKeySecond,
	)

	res, err := client.Get(h.URL(path))
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, res.StatusCode)

	body := readBody(res)
	require.Contains(t, body, `data-login-url="/login?popup=1"`)
	require.Contains(t, body, `data-login-origin="http://localhost:8080"`)
	require.Contains(t, body, `data-login-fullpage="/login"`)
	require.Contains(t, body, `data-popup-blocked hidden`)
	require.Contains(t, body, `data-popup-status`)
}

func TestLoginPopupAuthenticatedTriggersPostMessage(t *testing.T) {
	h := NewServerHarness(t)
	client := h.NewClient(true)

	authCookie := h.MustUserSessionCookie(h.Data.PrimaryUser.Id)
	h.SetCookie(client, authCookie)

	res, err := client.Get(h.URL("/login?popup=1"))
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, res.StatusCode)

	body := readBody(res)
	normalized := strings.ReplaceAll(body, `\/`, "/")
	require.Contains(t, normalized, "const targetOrigin = 'http://localhost:8080'")
	require.Contains(t, normalized, "postMessage(payload, targetOrigin);")
	require.Contains(t, normalized, "window.close();")
}

func TestLoginPopupFormPreservesPopupParameter(t *testing.T) {
	h := NewServerHarness(t)
	client := h.NewClient(true)

	res, err := client.Get(h.URL("/login?popup=1"))
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, res.StatusCode)

	body := readBody(res)
	require.Contains(t, body, `<input type="hidden" name="popup" value="1">`)
	require.Contains(t, body, "popup-note")
}
