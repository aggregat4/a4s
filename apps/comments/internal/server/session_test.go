package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
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
