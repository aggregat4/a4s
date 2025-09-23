package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"aggregat4/go-commentservice/internal/domain"
	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
)

// Create a mock server with specific user session
func createServerWithUserSession(t *testing.T) (*http.Server, *Controller, func()) {
	srv, controller := waitForServer(t)

	cleanup := func() {
		_ = srv.Close()
		controller.Store.Close()
	}

	return srv, controller, cleanup
}

// Create a mock server with admin session
func createServerWithAdminSession(t *testing.T) (*http.Server, *Controller, func()) {
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

// Test role validation functions
func TestAdminUserRoleValidation(t *testing.T) {
	testCases := []struct {
		name        string
		roles       []string
		serviceKey  string
		expectAdmin bool
		expectSuper bool
	}{
		{"Service admin for correct service", []string{"admin-blog1", "user"}, "blog1", true, false},
		{"Service admin for wrong service", []string{"admin-blog1", "user"}, "blog2", false, false},
		{"Super admin", []string{"superadmin", "user"}, "blog1", true, true},
		{"Super admin for any service", []string{"superadmin"}, "anythinf", true, true},
		{"Regular user", []string{"user", "member"}, "blog1", false, false},
		{"Multiple service admin", []string{"admin-blog1", "admin-blog2"}, "blog1", true, false},
		{"No roles", []string{}, "blog1", false, false},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			adminUser := domain.AdminUser{
				UserId: "test",
				Roles:  tc.roles,
			}

			hasServiceAdmin := adminUser.HasServiceAdminRole(tc.serviceKey)
			isSuperAdmin := adminUser.IsSuperAdmin()

			assert.Equal(t, tc.expectAdmin, hasServiceAdmin, "Service admin check failed")
			assert.Equal(t, tc.expectSuper, isSuperAdmin, "Super admin check failed")
		})
	}
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

func TestFindOrCreateUserByExternalId(t *testing.T) {
	_, controller, cleanup := createServerWithUserSession(t)
	defer cleanup()

	user1, err := controller.Store.FindOrCreateUserByExternalId("new_user_123")
	assert.NoError(t, err)
	assert.Equal(t, "new_user_123", user1.ExternalUserId)
	assert.True(t, user1.Id > 0)

	user2, err := controller.Store.FindOrCreateUserByExternalId("new_user_123")
	assert.NoError(t, err)
	assert.Equal(t, user1.Id, user2.Id)
	assert.Equal(t, "new_user_123", user2.ExternalUserId)
}

func TestGetCommentsByServiceAndStatus(t *testing.T) {
	_, controller, cleanup := createServerWithUserSession(t)
	defer cleanup()

	service1Id, _ := createTestServices(t, controller.Store)
	regularUserId, _, _ := createTestUsersWithExternalIds(t, controller.Store)

	commentId1, err := controller.Store.CreateComment(
		domain.CommentStatusApproved,
		service1Id,
		TEST_SERVICE_KEY_1,
		regularUserId,
		"test-post",
		"Test comment for service 1",
		"Test Author",
		"https://test.com",
		"https://example.com/post")
	assert.NoError(t, err)

	comments, err := controller.Store.GetCommentsByServiceAndStatus(TEST_SERVICE_KEY_1, []domain.CommentStatus{domain.CommentStatusApproved})
	assert.NoError(t, err)
	assert.True(t, len(comments) > 0)

	found := false
	for _, comment := range comments {
		if comment.Id == commentId1 {
			found = true
			assert.Equal(t, TEST_SERVICE_KEY_1, comment.ServiceKey)
			assert.Equal(t, domain.CommentStatusApproved, comment.Status)
			break
		}
	}
	assert.True(t, found, "Created comment should be found in results")
}

func TestGetAllServices(t *testing.T) {
	_, controller, cleanup := createServerWithUserSession(t)
	defer cleanup()

	createTestServices(t, controller.Store)

	services, err := controller.Store.GetAllServices()
	assert.NoError(t, err)
	assert.True(t, len(services) >= 2)

	serviceKeys := make(map[string]bool)
	for _, service := range services {
		serviceKeys[service.ServiceKey] = true
	}

	assert.True(t, serviceKeys[TEST_SERVICE_KEY_1], "Service 1 should be in results")
	assert.True(t, serviceKeys[TEST_SERVICE_KEY_2], "Service 2 should be in results")
}
