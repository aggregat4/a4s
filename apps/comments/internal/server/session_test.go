package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
)

// Create a mock server with specific user session
func createServerWithUserSession(t *testing.T) (*testServer, *Controller, func()) {
	srv, controller := waitForServer(t)

	cleanup := func() {
		_ = srv.Close()
		controller.Store.Close()
	}

	return srv, controller, cleanup
}

// Create a mock server with admin session
func createServerWithAdminSession(t *testing.T) (*testServer, *Controller, func()) {
	srv, controller := waitForServer(t)

	cleanup := func() {
		_ = srv.Close()
		controller.Store.Close()
	}

	return srv, controller, cleanup
}

// Test that session functions don't crash when no session exists
func TestUserSessionWithoutSession(t *testing.T) {
	_, controller, cleanup := createServerWithUserSession(t)
	defer cleanup()

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	_, err := controller.getUserIdFromSession(req)
	assert.Error(t, err, "Should return error when no session exists")
}

// Test that admin session functions don't crash when no session exists
func TestAdminSessionWithoutSession(t *testing.T) {
	_, controller, cleanup := createServerWithAdminSession(t)
	defer cleanup()

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	_, err := controller.getAdminUserFromSession(req)
	assert.Error(t, err, "Should return error when no admin session exists")

	_, err = controller.getAdminUserIdFromSession(req)
	assert.Error(t, err, "Should return error when no admin session exists")

	_, err = controller.getAdminRolesFromSession(req)
	assert.Error(t, err, "Should return error when no admin roles exist")
}

func TestServiceAdminAuthMiddleware(t *testing.T) {
	_, controller, cleanup := createServerWithAdminSession(t)
	defer cleanup()

	req := httptest.NewRequest(http.MethodGet, "/admin/blog1/comments", nil)
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("servicekey", "blog1")
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))

	rec := httptest.NewRecorder()

	handler := controller.serviceAdminAuthMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	handler.ServeHTTP(rec, req)
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestSuperAdminAuthMiddleware(t *testing.T) {
	_, controller, cleanup := createServerWithAdminSession(t)
	defer cleanup()

	req := httptest.NewRequest(http.MethodGet, "/superadmin/services", nil)
	rec := httptest.NewRecorder()

	handler := controller.superAdminAuthMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	handler.ServeHTTP(rec, req)
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}
