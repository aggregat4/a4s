package server

import (
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// postCommentWith submits a comment as a logged-in user, with the headers a
// browser would send from where the form is.
func postCommentWith(t *testing.T, h *ServerHarness, text string, headers map[string]string) int {
	t.Helper()
	client := h.NewClient(false)
	h.SetCookie(client, h.MustUserSessionCookie(h.Data.AdditionalUser.Id))
	form := url.Values{}
	form.Set("comment", text)
	form.Set("name", "Reader")
	form.Set("parentUrl", "https://blog.example.com/posts/2")
	path := fmt.Sprintf("/users/%d/services/%s/posts/%s/comments/",
		h.Data.AdditionalUser.Id, h.Data.Service.ServiceKey, testPostKeySecond)
	req, err := http.NewRequest(http.MethodPost, h.URL(path), strings.NewReader(form.Encode()))
	require.NoError(t, err)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	for name, value := range headers {
		req.Header.Set(name, value)
	}
	res, err := client.Do(req)
	require.NoError(t, err)
	res.Body.Close()
	return res.StatusCode
}

func storedComment(t *testing.T, h *ServerHarness, text string) bool {
	t.Helper()
	comments, err := h.Store.GetCommentsForUser(h.Data.AdditionalUser.Id)
	require.NoError(t, err)
	for _, c := range comments {
		if c.Comment == text {
			return true
		}
	}
	return false
}

func TestCommentsFromOtherSitesAreRejected(t *testing.T) {
	for name, headers := range map[string]map[string]string{
		"a cross-site page": {"Sec-Fetch-Site": "cross-site"},
		// The embedding blog itself is another site: only the comments
		// iframe, served from the comments origin, may post.
		"the embedding site without fetch metadata": {"Origin": "https://example.com"},
	} {
		t.Run(name, func(t *testing.T) {
			h := NewServerHarness(t)
			require.Equal(t, http.StatusForbidden, postCommentWith(t, h, "Forged comment", headers))
			require.False(t, storedComment(t, h, "Forged comment"))
		})
	}
}

func TestCommentsFromTheCommentsIframeAreAccepted(t *testing.T) {
	h := NewServerHarness(t)
	require.Equal(t, http.StatusFound, postCommentWith(t, h, "From the iframe", map[string]string{"Sec-Fetch-Site": "same-origin"}))
	require.True(t, storedComment(t, h, "From the iframe"))
}
