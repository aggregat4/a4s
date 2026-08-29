package server

import (
	"fmt"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestAddCommentFormExposesEmbedLoginMetadata(t *testing.T) {
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
	require.Contains(t, body, `data-embed-login-path="/login/services/TESTSERVICE/embed"`)
	require.Contains(t, body, `data-embedder-origin="https://example.com"`)
}

func TestEmbedLoginRedirectsAuthenticatedUserToRegisteredOrigin(t *testing.T) {
	h := NewServerHarness(t)
	client := h.NewClient(true)

	authCookie := h.MustUserSessionCookie(h.Data.PrimaryUser.Id)
	h.SetCookie(client, authCookie)

	client.CheckRedirect = func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}

	res, err := client.Get(h.URL("/login/services/TESTSERVICE/embed?returnTo=https%3A%2F%2Fexample.com%2Fposts%2F1"))
	require.NoError(t, err)
	require.Equal(t, http.StatusFound, res.StatusCode)
	require.Equal(t, "https://example.com/posts/1", res.Header.Get("Location"))
}

func TestEmbedLoginRejectsUnregisteredReturnOrigin(t *testing.T) {
	h := NewServerHarness(t)
	client := h.NewClient(true)

	authCookie := h.MustUserSessionCookie(h.Data.PrimaryUser.Id)
	h.SetCookie(client, authCookie)

	res, err := client.Get(h.URL("/login/services/TESTSERVICE/embed?returnTo=https%3A%2F%2Fevil.example%2Fposts%2F1"))
	require.NoError(t, err)
	require.Equal(t, http.StatusBadRequest, res.StatusCode)
}
