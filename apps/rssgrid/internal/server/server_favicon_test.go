package server

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestHandleFavicon(t *testing.T) {
	server := testServer(t, mockStoreEmpty())
	req := httptest.NewRequest("GET", "/favicon.svg", nil)
	w := httptest.NewRecorder()
	server.handleFavicon(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Equal(t, "image/svg+xml", w.Header().Get("Content-Type"))
	assert.NotEmpty(t, w.Body.Bytes(), "favicon body should not be empty")
}

func TestIsPublicPath(t *testing.T) {
	assert.True(t, isPublicPath("/auth/callback"), "auth callback must be public")
	assert.True(t, isPublicPath("/favicon.svg"), "favicon must be public so browsers can fetch it pre-login")
	assert.False(t, isPublicPath("/"), "dashboard must be protected")
	assert.False(t, isPublicPath("/settings"), "settings must be protected")
}
