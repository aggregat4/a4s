package server

import (
	"aggregat4/go-commentservice/internal/domain"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/labstack/echo/v4"
	"github.com/stretchr/testify/assert"
)

// Create a mock server with specific user session
func createServerWithUserSession(t *testing.T) (*echo.Echo, Controller, func()) {
	echoServer, controller := waitForServer(t)

	cleanup := func() {
		echoServer.Close()
		controller.Store.Close()
	}

	return echoServer, controller, cleanup
}

// Create a mock server with admin session
func createServerWithAdminSession(t *testing.T) (*echo.Echo, Controller, func()) {
	echoServer, controller := waitForServer(t)

	cleanup := func() {
		echoServer.Close()
		controller.Store.Close()
	}

	return echoServer, controller, cleanup
}

// Test that session functions don't crash when no session exists
func TestUserSessionWithoutSession(t *testing.T) {
	_, _, cleanup := createServerWithUserSession(t)
	defer cleanup()

	// Create echo context for session testing
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	// Test retrieving user ID from empty session - should return error
	_, err := getUserIdFromSession(c)
	assert.Error(t, err, "Should return error when no session exists")
}

// Test that admin session functions don't crash when no session exists
func TestAdminSessionWithoutSession(t *testing.T) {
	_, _, cleanup := createServerWithAdminSession(t)
	defer cleanup()

	// Create echo context for session testing
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	// Test retrieving admin user from empty session - should return error
	_, err := getAdminUserFromSession(c)
	assert.Error(t, err, "Should return error when no admin session exists")

	_, err = getAdminUserIdFromSession(c)
	assert.Error(t, err, "Should return error when no admin session exists")

	_, err = getAdminRolesFromSession(c)
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

// Test repository methods for user management
func TestFindOrCreateUserByExternalId(t *testing.T) {
	_, controller, cleanup := createServerWithUserSession(t)
	defer cleanup()

	// Test creating new user
	user1, err := controller.Store.FindOrCreateUserByExternalId("new_user_123")
	assert.NoError(t, err)
	assert.Equal(t, "new_user_123", user1.ExternalUserId)
	assert.True(t, user1.Id > 0)

	// Test finding existing user
	user2, err := controller.Store.FindOrCreateUserByExternalId("new_user_123")
	assert.NoError(t, err)
	assert.Equal(t, user1.Id, user2.Id) // Should be same user
	assert.Equal(t, "new_user_123", user2.ExternalUserId)
}

func TestGetCommentsByServiceAndStatus(t *testing.T) {
	_, controller, cleanup := createServerWithUserSession(t)
	defer cleanup()

	// Create additional test services and comments
	service1Id, _ := createTestServices(t, controller.Store)
	regularUserId, _, _ := createTestUsersWithExternalIds(t, controller.Store)

	// Create comments for specific service
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

	// Test getting comments by service and status
	comments, err := controller.Store.GetCommentsByServiceAndStatus(TEST_SERVICE_KEY_1, []domain.CommentStatus{domain.CommentStatusApproved})
	assert.NoError(t, err)
	assert.True(t, len(comments) > 0)

	// Verify comment is in results
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

	// Create additional services
	createTestServices(t, controller.Store)

	// Test getting all services
	services, err := controller.Store.GetAllServices()
	assert.NoError(t, err)
	assert.True(t, len(services) >= 2) // At least the test services we created

	// Check that our test services are included
	serviceKeys := make(map[string]bool)
	for _, service := range services {
		serviceKeys[service.ServiceKey] = true
	}

	assert.True(t, serviceKeys[TEST_SERVICE_KEY_1], "Service 1 should be in results")
	assert.True(t, serviceKeys[TEST_SERVICE_KEY_2], "Service 2 should be in results")
}

// Mock response recorder for testing
type MockResponseRecorder struct {
	StatusCode int
	Headers    map[string]string
	Body       []byte
}

func (m *MockResponseRecorder) Header() http.Header {
	if m.Headers == nil {
		m.Headers = make(map[string]string)
	}
	header := make(http.Header)
	for k, v := range m.Headers {
		header.Set(k, v)
	}
	return header
}

func (m *MockResponseRecorder) Write(data []byte) (int, error) {
	m.Body = append(m.Body, data...)
	return len(data), nil
}

func (m *MockResponseRecorder) WriteHeader(code int) {
	m.StatusCode = code
}

type TestResponseRecorder struct {
	ResponseRecorder *MockResponseRecorder
}

func (t *TestResponseRecorder) Header() http.Header {
	return t.ResponseRecorder.Header()
}

func (t *TestResponseRecorder) Write(data []byte) (int, error) {
	return t.ResponseRecorder.Write(data)
}

func (t *TestResponseRecorder) WriteHeader(code int) {
	t.ResponseRecorder.WriteHeader(code)
}

// Test middleware functions
func TestServiceAdminAuthMiddleware(t *testing.T) {
	middleware := CreateServiceAdminAuthMiddleware()

	e := echo.New()
	req, _ := http.NewRequest("GET", "/admin/blog1/comments", nil)
	rec := &TestResponseRecorder{ResponseRecorder: &MockResponseRecorder{}}
	c := e.NewContext(req, rec)
	c.SetParamNames("servicekey")
	c.SetParamValues("blog1")

	// Test without session - should get unauthorized
	handler := middleware(func(c echo.Context) error {
		return c.String(200, "OK")
	})

	err := handler(c)
	// Should return error or render unauthorized page
	assert.Error(t, err)
}

func TestSuperAdminAuthMiddleware(t *testing.T) {
	middleware := CreateSuperAdminAuthMiddleware()

	e := echo.New()
	req, _ := http.NewRequest("GET", "/superadmin/services", nil)
	rec := &TestResponseRecorder{ResponseRecorder: &MockResponseRecorder{}}
	c := e.NewContext(req, rec)

	// Test without session - should get unauthorized
	handler := middleware(func(c echo.Context) error {
		return c.String(200, "OK")
	})

	err := handler(c)
	// Should return error or render unauthorized page
	assert.Error(t, err)
}
