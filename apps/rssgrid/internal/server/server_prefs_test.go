package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

func postForm(t *testing.T, server *Server, path, body string, userID int64) (*http.Request, *httptest.ResponseRecorder) {
	t.Helper()
	req := httptest.NewRequest("POST", path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	w := httptest.NewRecorder()
	session, _ := server.sessions.Get(req, "user_session")
	session.Values["user_id"] = userID
	req = withUserID(req, userID)
	return req, w
}

func TestUpdatePreferences_RejectsOutOfRange(t *testing.T) {
	cases := []string{
		"postsPerFeed=0&columns=2",
		"postsPerFeed=-1&columns=2",
		"postsPerFeed=51&columns=2",
		"postsPerFeed=abc&columns=2",
		"postsPerFeed=10&columns=0",
		"postsPerFeed=10&columns=6",
		"postsPerFeed=10&columns=",
	}
	for _, body := range cases {
		t.Run(body, func(t *testing.T) {
			store := mockStoreEmpty()
			server := testServer(t, store)
			req, w := postForm(t, server, "/settings/preferences", body, 1)
			server.handleUpdatePreferences(w, req)
			assertRedirect(t, w, "/settings")
			assert.False(t, store.preferencesSet, "invalid preferences must not be stored")
		})
	}
}

func TestUpdatePreferences_AcceptsBounds(t *testing.T) {
	store := mockStoreEmpty()
	server := testServer(t, store)
	req, w := postForm(t, server, "/settings/preferences", "postsPerFeed=50&columns=5", 1)
	server.handleUpdatePreferences(w, req)
	assertRedirect(t, w, "/settings")
	assert.True(t, store.preferencesSet)
	assert.Equal(t, 50, store.postsPerFeed)
	assert.Equal(t, 5, store.columns)
}

func TestRequireUser(t *testing.T) {
	server := testServer(t, mockStoreEmpty())
	var seen int64
	handler := server.requireUser(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = userIDFrom(r)
	}))

	// No user in the session: rejected before reaching the handler.
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest("GET", "/", nil))
	assert.Equal(t, http.StatusUnauthorized, w.Code)
	assert.Zero(t, seen)

	// User in the session: the handler sees the ID in the context.
	req := httptest.NewRequest("GET", "/", nil)
	session, _ := server.sessions.Get(req, "user_session")
	session.Values["user_id"] = int64(42)
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code)
	assert.Equal(t, int64(42), seen)
}
