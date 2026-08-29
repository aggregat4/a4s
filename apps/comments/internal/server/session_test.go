package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aggregat4/go-baselib/lang"
	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Test that session functions don't crash when no session exists
func TestUserSessionWithoutSession(t *testing.T) {
	h := NewServerHarness(t)

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	_, err := h.Controller.getUserIdFromSession(req)
	assert.Error(t, err, "Should return error when no session exists")
}

// Test that admin session functions don't crash when no session exists
func TestAdminSessionWithoutSession(t *testing.T) {
	h := NewServerHarness(t)

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	_, err := h.Controller.getAdminUserFromSession(req)
	assert.Error(t, err, "Should return error when no admin session exists")

	_, err = h.Controller.getAdminUserIdFromSession(req)
	assert.Error(t, err, "Should return error when no admin session exists")

	_, err = h.Controller.getAdminRolesFromSession(req)
	assert.Error(t, err, "Should return error when no admin roles exist")
}

func TestServiceAdminAuthMiddleware(t *testing.T) {
	h := NewServerHarness(t)

	req := httptest.NewRequest(http.MethodGet, "/admin/blog1/comments", nil)
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("servicekey", "blog1")
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))

	rec := httptest.NewRecorder()

	handler := h.Controller.serviceAdminAuthMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	handler.ServeHTTP(rec, req)
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestSuperAdminAuthMiddleware(t *testing.T) {
	h := NewServerHarness(t)

	req := httptest.NewRequest(http.MethodGet, "/superadmin/services", nil)
	rec := httptest.NewRecorder()

	handler := h.Controller.superAdminAuthMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	handler.ServeHTTP(rec, req)
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestLogoutClearsSession(t *testing.T) {
	h := NewServerHarness(t)

	loginReq := httptest.NewRequest(http.MethodGet, "/", nil)
	loginRec := httptest.NewRecorder()

	require.NoError(t, h.Controller.createUserSessionCookie(loginRec, loginReq, 7))

	logoutBody := strings.NewReader("redirectTo=/")
	logoutReq := httptest.NewRequest(http.MethodPost, "/logout", logoutBody)
	logoutReq.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	for _, cookie := range loginRec.Result().Cookies() {
		logoutReq.AddCookie(cookie)
	}

	logoutRec := httptest.NewRecorder()
	h.Controller.Logout(logoutRec, logoutReq)

	res := logoutRec.Result()
	assert.Equal(t, http.StatusFound, res.StatusCode)
	assert.Equal(t, "/", res.Header.Get("Location"))

	foundSessionCookie := false
	for _, cookie := range res.Cookies() {
		if cookie.Name == authenticatedUserCookieName {
			foundSessionCookie = true
			assert.LessOrEqual(t, cookie.MaxAge, 0, "logout should expire the session cookie")
		}
	}
	assert.True(t, foundSessionCookie, "logout should set an expired session cookie")

	followReq := httptest.NewRequest(http.MethodGet, "/", nil)
	for _, cookie := range res.Cookies() {
		followReq.AddCookie(cookie)
	}

	_, err := h.Controller.getUserFromSession(followReq)
	assert.Error(t, err)
	assert.ErrorIs(t, err, lang.ErrNotFound)
}

func TestUserSessionRehydratesMissingUserFromExternalID(t *testing.T) {
	h := NewServerHarness(t)

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	sess, err := h.Controller.getSession(req)
	require.NoError(t, err)
	sess.Values["userid"] = 999999
	sess.Values["externaluserid"] = "returning-user"
	require.NoError(t, sess.Save(req, rec))

	followReq := httptest.NewRequest(http.MethodGet, "/", nil)
	for _, cookie := range rec.Result().Cookies() {
		followReq.AddCookie(cookie)
	}

	user, err := h.Controller.getUserFromSession(followReq)
	require.NoError(t, err)
	assert.Equal(t, "returning-user", user.ExternalUserId)
	assert.NotZero(t, user.Id)
}

func TestLegacyAdminSessionRehydratesMissingUserFromAdminID(t *testing.T) {
	h := NewServerHarness(t)

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	sess, err := h.Controller.getSession(req)
	require.NoError(t, err)
	sess.Values["userid"] = 999999
	sess.Values["adminuserid"] = "legacy-admin-user"
	sess.Values["adminroles"] = []string{"admin-" + h.Data.Service.ServiceKey}
	require.NoError(t, sess.Save(req, rec))

	followReq := httptest.NewRequest(http.MethodGet, "/", nil)
	for _, cookie := range rec.Result().Cookies() {
		followReq.AddCookie(cookie)
	}

	user, err := h.Controller.getUserFromSession(followReq)
	require.NoError(t, err)
	assert.Equal(t, "legacy-admin-user", user.ExternalUserId)
	assert.NotZero(t, user.Id)
}
