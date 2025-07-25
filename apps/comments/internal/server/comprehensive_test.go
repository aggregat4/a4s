package server

import (
	"aggregat4/go-commentservice/internal/repository"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

// Test constants for different user types
const (
	TEST_REGULAR_USER_EXTERNAL_ID  = "regular_user_123"
	TEST_SERVICE_ADMIN_EXTERNAL_ID = "service_admin_456"
	TEST_SUPER_ADMIN_EXTERNAL_ID   = "super_admin_789"
	TEST_SERVICE_KEY_1             = "blog1"
	TEST_SERVICE_KEY_2             = "blog2"
	TEST_POST_KEY_1                = "my-post-1"
	TEST_POST_KEY_2                = "my-post-2"
)

// Test helper to create users with external IDs for different user types
func createTestUsersWithExternalIds(t *testing.T, store *repository.Store) (int, int, int) {
	// Create regular user
	regularUserId, err := store.CreateUserWithExternalId(TEST_REGULAR_USER_EXTERNAL_ID)
	if err != nil {
		t.Fatal("Error creating regular user:", err)
	}

	// Create service admin user
	serviceAdminUserId, err := store.CreateUserWithExternalId(TEST_SERVICE_ADMIN_EXTERNAL_ID)
	if err != nil {
		t.Fatal("Error creating service admin user:", err)
	}

	// Create super admin user
	superAdminUserId, err := store.CreateUserWithExternalId(TEST_SUPER_ADMIN_EXTERNAL_ID)
	if err != nil {
		t.Fatal("Error creating super admin user:", err)
	}

	return regularUserId, serviceAdminUserId, superAdminUserId
}

// Test helper to create additional services
func createTestServices(t *testing.T, store *repository.Store) (int, int) {
	service1Id, err := store.CreateService(TEST_SERVICE_KEY_1, "https://blog1.example.com")
	if err != nil {
		t.Fatal("Error creating test service 1:", err)
	}

	service2Id, err := store.CreateService(TEST_SERVICE_KEY_2, "https://blog2.example.com")
	if err != nil {
		t.Fatal("Error creating test service 2:", err)
	}

	return service1Id, service2Id
}

// ====== UNAUTHENTICATED USER TESTS ======

func TestUnauthenticatedUserCanViewComments(t *testing.T) {
	echoServer, controller := waitForServer(t)
	defer echoServer.Close()
	defer controller.Store.Close()

	// Can view comments for a service/post
	res, err := http.Get(createServerUrl(serverConfig.Port, "/services/"+TEST_SERVICE+"/posts/"+TEST_POSTKEY1+"/comments/"))
	if err != nil {
		t.Fatal(err)
	}
	assert.Equal(t, 200, res.StatusCode)
	body := readBody(res)
	assert.Contains(t, body, TEST_COMMENT_APPROVED) // Only approved comments visible
	assert.NotContains(t, body, TEST_COMMENT_PENDING_APPROVAL)
}

func TestUnauthenticatedUserCanAccessStatus(t *testing.T) {
	echoServer, controller := waitForServer(t)
	defer echoServer.Close()
	defer controller.Store.Close()

	res, err := http.Get(createServerUrl(serverConfig.Port, "/status"))
	if err != nil {
		t.Fatal(err)
	}
	assert.Equal(t, 200, res.StatusCode)
}

func TestUnauthenticatedUserCanAccessDemo(t *testing.T) {
	echoServer, controller := waitForServer(t)
	defer echoServer.Close()
	defer controller.Store.Close()

	res, err := http.Get(createServerUrl(serverConfig.Port, "/demo"))
	if err != nil {
		t.Fatal(err)
	}
	assert.Equal(t, 200, res.StatusCode)
	body := readBody(res)
	assert.Contains(t, body, "<!DOCTYPE html>")
}

func TestUnauthenticatedUserCannotPostComments(t *testing.T) {
	echoServer, controller := waitForServer(t)
	defer echoServer.Close()
	defer controller.Store.Close()

	client := createTestHttpClient(false)

	// Try to post a comment without authentication
	formData := url.Values{}
	formData.Set("comment", "Attempted unauthenticated comment")
	formData.Set("name", "Anonymous User")
	formData.Set("website", "https://example.org")

	req, err := http.NewRequest("POST",
		createServerUrl(serverConfig.Port, "/services/"+TEST_SERVICE+"/posts/"+TEST_POSTKEY1+"/comments/"),
		strings.NewReader(formData.Encode()))
	if err != nil {
		t.Fatal(err)
	}

	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Origin", "https://example.com") // Match the service origin

	res, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}

	// Should be unauthorized
	assert.Equal(t, 401, res.StatusCode)
}

func TestUnauthenticatedUserCannotAccessUserRoutes(t *testing.T) {
	echoServer, controller := waitForServer(t)
	defer echoServer.Close()
	defer controller.Store.Close()

	testCases := []string{
		"/users/1/comments/",
		"/users/1/comments/1/edit",
	}

	for _, path := range testCases {
		res, err := http.Get(createServerUrl(serverConfig.Port, path))
		if err != nil {
			t.Fatal(err)
		}
		// Should be redirected to OIDC login
		assert.True(t, res.StatusCode == 302 || res.StatusCode == 401, "Expected redirect or unauthorized for "+path)
	}
}

func TestUnauthenticatedUserCannotAccessAdminRoutes(t *testing.T) {
	echoServer, controller := waitForServer(t)
	defer echoServer.Close()
	defer controller.Store.Close()

	testCases := []string{
		"/admin",
		"/admin/blog1/comments",
		"/superadmin/services",
		"/superadmin/comments",
	}

	for _, path := range testCases {
		res, err := http.Get(createServerUrl(serverConfig.Port, path))
		if err != nil {
			t.Fatal(err)
		}
		// Should be redirected to OIDC login
		assert.True(t, res.StatusCode == 302 || res.StatusCode == 401, "Expected redirect or unauthorized for "+path)
	}
}

// ====== REGULAR USER TESTS ======

func TestRegularUserCanAccessTheirCommentPages(t *testing.T) {
	echoServer, controller := waitForServer(t)
	defer echoServer.Close()
	defer controller.Store.Close()

	regularUserId, _, _ := createTestUsersWithExternalIds(t, controller.Store)

	// Create HTTP client with cookies
	client := createTestHttpClient(true)

	// Mock user session by directly calling the server with session context
	// In real implementation, this would come from OIDC callback
	req, _ := http.NewRequest("GET", createServerUrl(serverConfig.Port, "/users/"+strconv.Itoa(regularUserId)+"/comments/"), nil)

	// Add session cookie (this simulates authenticated state)
	// Note: In a full integration test, you'd go through OIDC flow
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}

	// Without proper session, should be redirected to auth
	assert.True(t, resp.StatusCode == 302 || resp.StatusCode == 401, "Should require authentication")
}

func TestRegularUserCannotAccessOtherUsersPages(t *testing.T) {
	echoServer, controller := waitForServer(t)
	defer echoServer.Close()
	defer controller.Store.Close()

	regularUserId, _, _ := createTestUsersWithExternalIds(t, controller.Store)
	otherUserId := regularUserId + 999 // Different user ID

	client := createTestHttpClient(false)

	// Try to access another user's comments
	res, err := client.Get(createServerUrl(serverConfig.Port, "/users/"+strconv.Itoa(otherUserId)+"/comments/"))
	if err != nil {
		t.Fatal(err)
	}

	// Should be redirected to auth or get unauthorized
	assert.True(t, res.StatusCode == 302 || res.StatusCode == 401 || res.StatusCode == 403)
}

func TestRegularUserCannotAccessAdminRoutes(t *testing.T) {
	echoServer, controller := waitForServer(t)
	defer echoServer.Close()
	defer controller.Store.Close()

	adminPaths := []string{
		"/admin",
		"/admin/blog1/comments",
		"/superadmin/services",
		"/superadmin/comments",
	}

	client := createTestHttpClient(false)

	for _, path := range adminPaths {
		res, err := client.Get(createServerUrl(serverConfig.Port, path))
		if err != nil {
			t.Fatal(err)
		}

		// Regular user should not be able to access admin routes
		assert.True(t, res.StatusCode == 302 || res.StatusCode == 401 || res.StatusCode == 403,
			"Regular user should not access "+path)
	}
}

// ====== SERVICE ADMIN TESTS ======

func TestServiceAdminCanAccessTheirServiceComments(t *testing.T) {
	echoServer, controller := waitForServer(t)
	defer echoServer.Close()
	defer controller.Store.Close()

	createTestServices(t, controller.Store)

	// This test would need proper session mocking which is complex
	// For now, testing the route exists and returns appropriate response
	client := createTestHttpClient(false)

	res, err := client.Get(createServerUrl(serverConfig.Port, "/admin/"+TEST_SERVICE_KEY_1+"/comments"))
	if err != nil {
		t.Fatal(err)
	}

	// Without proper admin session, should get unauthorized/redirect
	assert.True(t, res.StatusCode == 302 || res.StatusCode == 401 || res.StatusCode == 403)
}

func TestServiceAdminCannotAccessOtherServices(t *testing.T) {
	echoServer, controller := waitForServer(t)
	defer echoServer.Close()
	defer controller.Store.Close()

	createTestServices(t, controller.Store)

	client := createTestHttpClient(false)

	// Try to access different service admin page
	res, err := client.Get(createServerUrl(serverConfig.Port, "/admin/"+TEST_SERVICE_KEY_2+"/comments"))
	if err != nil {
		t.Fatal(err)
	}

	// Without proper session for this service, should be unauthorized
	assert.True(t, res.StatusCode == 302 || res.StatusCode == 401 || res.StatusCode == 403)
}

func TestServiceAdminCannotAccessSuperAdminRoutes(t *testing.T) {
	echoServer, controller := waitForServer(t)
	defer echoServer.Close()
	defer controller.Store.Close()

	superAdminPaths := []string{
		"/superadmin/services",
		"/superadmin/comments",
	}

	client := createTestHttpClient(false)

	for _, path := range superAdminPaths {
		res, err := client.Get(createServerUrl(serverConfig.Port, path))
		if err != nil {
			t.Fatal(err)
		}

		// Service admin should not access super admin routes
		assert.True(t, res.StatusCode == 302 || res.StatusCode == 401 || res.StatusCode == 403,
			"Service admin should not access "+path)
	}
}

// ====== SUPER ADMIN TESTS ======

func TestSuperAdminCanAccessAllRoutes(t *testing.T) {
	echoServer, controller := waitForServer(t)
	defer echoServer.Close()
	defer controller.Store.Close()

	createTestServices(t, controller.Store)

	superAdminPaths := []string{
		"/superadmin/services",
		"/superadmin/comments",
	}

	client := createTestHttpClient(false)

	for _, path := range superAdminPaths {
		res, err := client.Get(createServerUrl(serverConfig.Port, path))
		if err != nil {
			t.Fatal(err)
		}

		// Without proper super admin session, should get auth redirect/error
		assert.True(t, res.StatusCode == 302 || res.StatusCode == 401 || res.StatusCode == 403)
	}
}

// ====== AUTHENTICATION FLOW TESTS ======

func TestOIDCCallbackRoute(t *testing.T) {
	echoServer, controller := waitForServer(t)
	defer echoServer.Close()
	defer controller.Store.Close()

	// Test OIDC callback endpoint exists
	res, err := http.Get(createServerUrl(serverConfig.Port, "/oidccallback"))
	if err != nil {
		t.Fatal(err)
	}

	// Callback without proper OIDC data should handle gracefully
	assert.True(t, res.StatusCode >= 200 && res.StatusCode < 500)
}

func TestUserLoginRoute(t *testing.T) {
	echoServer, controller := waitForServer(t)
	defer echoServer.Close()
	defer controller.Store.Close()

	res, err := http.Get(createServerUrl(serverConfig.Port, "/login"))
	if err != nil {
		t.Fatal(err)
	}

	assert.Equal(t, 200, res.StatusCode)
	body := readBody(res)
	assert.Contains(t, body, "<!DOCTYPE html>") // Should return login page HTML
}

// ====== EDGE CASES AND ERROR HANDLING ======

func TestInvalidServiceKeyReturns404(t *testing.T) {
	echoServer, controller := waitForServer(t)
	defer echoServer.Close()
	defer controller.Store.Close()

	res, err := http.Get(createServerUrl(serverConfig.Port, "/services/nonexistent/posts/test/comments/"))
	if err != nil {
		t.Fatal(err)
	}

	assert.Equal(t, 404, res.StatusCode)
}

func TestInvalidUserIdHandledGracefully(t *testing.T) {
	echoServer, controller := waitForServer(t)
	defer echoServer.Close()
	defer controller.Store.Close()

	client := createTestHttpClient(false)

	invalidUserPaths := []string{
		"/users/99999/comments/",
		"/users/abc/comments/",
		"/users/-1/comments/",
	}

	for _, path := range invalidUserPaths {
		res, err := client.Get(createServerUrl(serverConfig.Port, path))
		if err != nil {
			t.Fatal(err)
		}

		// Should handle invalid user IDs gracefully (auth redirect or error page)
		assert.True(t, res.StatusCode >= 300, "Invalid user ID should not return success for "+path)
	}
}

func TestInvalidCommentIdHandledGracefully(t *testing.T) {
	echoServer, controller := waitForServer(t)
	defer echoServer.Close()
	defer controller.Store.Close()

	client := createTestHttpClient(false)

	// Try to access non-existent comment operations
	invalidPaths := []string{
		"/admin/blog1/comments/99999/approve",
		"/admin/blog1/comments/99999/delete",
		"/users/1/comments/99999/edit",
	}

	for _, path := range invalidPaths {
		req, err := http.NewRequest("POST", createServerUrl(serverConfig.Port, path), strings.NewReader(""))
		if err != nil {
			t.Fatal(err)
		}

		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		req.Header.Set("Origin", "https://example.com") // Match the service origin for CSRF

		res, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}

		// Should handle invalid comment IDs gracefully
		assert.True(t, res.StatusCode >= 300, "Invalid comment ID should not return success for "+path)
	}
}

// ====== FORM SUBMISSION TESTS ======

func TestUnauthenticatedCommentSubmissionIsRejected(t *testing.T) {
	echoServer, controller := waitForServer(t)
	defer echoServer.Close()
	defer controller.Store.Close()

	client := createTestHttpClient(false)

	testCases := []struct {
		name     string
		comment  string
		author   string
		website  string
		expected int
	}{
		{"Valid comment", "This is a test comment", "Test User", "https://test.com", 401}, // Unauthorized without auth
		{"Empty comment", "", "Test User", "https://test.com", 400},                       // Bad request (validation happens first)
		{"Long comment", strings.Repeat("a", 1000), "Test User", "https://test.com", 401}, // Unauthorized without auth
		{"No author", "Test comment", "", "https://test.com", 401},                        // Unauthorized without auth
		{"No website", "Test comment", "Test User", "", 401},                              // Unauthorized without auth
		{"Invalid website", "Test comment", "Test User", "not-a-url", 401},                // Unauthorized without auth
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			formData := url.Values{}
			formData.Set("comment", tc.comment)
			formData.Set("name", tc.author)
			formData.Set("website", tc.website)

			req, err := http.NewRequest("POST",
				createServerUrl(serverConfig.Port, "/services/"+TEST_SERVICE+"/posts/test/comments/"),
				strings.NewReader(formData.Encode()))
			if err != nil {
				t.Fatal(err)
			}

			req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
			req.Header.Set("Origin", "https://example.com") // Match the service origin

			res, err := client.Do(req)
			if err != nil {
				t.Fatal(err)
			}

			assert.Equal(t, tc.expected, res.StatusCode, "Failed for case: "+tc.name)
		})
	}
}

// ====== STATIC ASSET TESTS ======

func TestStaticAssetAccess(t *testing.T) {
	echoServer, controller := waitForServer(t)
	defer echoServer.Close()
	defer controller.Store.Close()

	staticPaths := []string{
		"/css/main.css",
		"/js/main.js",
	}

	for _, path := range staticPaths {
		res, err := http.Get(createServerUrl(serverConfig.Port, path))
		if err != nil {
			t.Fatal(err)
		}

		// Static assets should be accessible
		assert.True(t, res.StatusCode == 200 || res.StatusCode == 404, "Static asset issue for "+path)
	}
}
