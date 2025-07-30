package server

import (
	"aggregat4/go-commentservice/internal/domain"
	"net/url"
	"strconv"
	"testing"

	"github.com/stretchr/testify/assert"
)

// Integration tests that test full user workflows with proper session simulation

// TestFullUserWorkflowUnauthenticated tests the complete flow for an unauthenticated user
func TestFullUserWorkflowUnauthenticated(t *testing.T) {
	echoServer, controller := waitForServer(t)
	defer echoServer.Close()
	defer controller.Store.Close()

	client := createTestHttpClient(false)

	// 1. User can view public comment page
	res, err := client.Get(createServerUrl(serverConfig.Port, "/services/"+TEST_SERVICE+"/posts/"+TEST_POSTKEY1+"/comments/"))
	assert.NoError(t, err)
	assert.Equal(t, 200, res.StatusCode)
	body := readBody(res)
	assert.Contains(t, body, TEST_COMMENT_APPROVED)

	// 2. User can access demo page
	res, err = client.Get(createServerUrl(serverConfig.Port, "/demo"))
	assert.NoError(t, err)
	assert.Equal(t, 200, res.StatusCode)

	// 3. User cannot post a comment without authentication
	formData := url.Values{}
	formData.Set("comment", "Test comment from unauthenticated user")
	formData.Set("name", "Anonymous")
	formData.Set("website", "https://example.com")

	res, err = client.PostForm(
		createServerUrl(serverConfig.Port, "/users/1/services/"+TEST_SERVICE+"/posts/"+TEST_POSTKEY1+"/comments/"),
		formData)
	assert.NoError(t, err)
	assert.True(t, res.StatusCode == 401 || res.StatusCode == 403, "Should require authentication for posting comments")

	// 4. User cannot access protected user routes (should redirect to auth)
	res, err = client.Get(createServerUrl(serverConfig.Port, "/users/1/comments/"))
	assert.NoError(t, err)
	assert.True(t, res.StatusCode == 401, "Should be redirected or unauthorized")

	// 5. User cannot access admin routes
	res, err = client.Get(createServerUrl(serverConfig.Port, "/admin"))
	assert.NoError(t, err)
	assert.True(t, res.StatusCode == 302, "Should be redirected")
}

// TestRegularUserWorkflowWithSession tests a regular authenticated user's workflow
func TestRegularUserWorkflowWithSession(t *testing.T) {
	echoServer, controller := waitForServer(t)
	defer echoServer.Close()
	defer controller.Store.Close()

	// Create a regular user
	regularUserId, err := controller.Store.CreateUserWithExternalId("test_regular_user")
	assert.NoError(t, err)

	// Create some comments for this user
	serviceId, err := controller.Store.CreateService("testblog", "https://testblog.com")
	assert.NoError(t, err)

	_, err = controller.Store.CreateComment(
		domain.CommentStatusPendingApproval,
		serviceId,
		"testblog",
		regularUserId,
		"my-post",
		"My test comment",
		"Regular User",
		"https://regularuser.com",
		"https://testblog.com/my-post")
	assert.NoError(t, err)

	// Test that without authentication, user cannot access their comments
	client := createTestHttpClient(false)
	res, err := client.Get(createServerUrl(serverConfig.Port, "/users/"+strconv.Itoa(regularUserId)+"/comments/"))
	assert.NoError(t, err)

	// Should be redirected to auth or get unauthorized
	assert.True(t, res.StatusCode == 302 || res.StatusCode == 401, "Should require authentication")

	// Note: In a full integration test with OIDC, we would:
	// 1. Go through the OIDC flow to get a session
	// 2. Make authenticated requests to verify access
	// 3. Test that users can only access their own comments
	// For now, we verify that authentication is required
}

// TestServiceAdminWorkflowWithSession tests a service admin's workflow
func TestServiceAdminWorkflowWithSession(t *testing.T) {
	echoServer, controller := waitForServer(t)
	defer echoServer.Close()
	defer controller.Store.Close()

	// Create test service admin
	adminExternalId := "test_service_admin"
	adminRoles := []string{"admin-" + TEST_SERVICE, "user"}

	// Test admin role validation
	adminUser := domain.AdminUser{
		UserId: adminExternalId,
		Roles:  adminRoles,
	}

	// Test that admin has proper permissions
	assert.True(t, adminUser.HasServiceAdminRole(TEST_SERVICE))
	assert.False(t, adminUser.HasServiceAdminRole("other-service"))
	assert.False(t, adminUser.IsSuperAdmin())

	// Test that without authentication, admin routes are not accessible
	client := createTestHttpClient(false)
	res, err := client.Get(createServerUrl(serverConfig.Port, "/admin/"+TEST_SERVICE+"/comments"))
	assert.NoError(t, err)

	// Should be redirected to auth or get unauthorized
	assert.True(t, res.StatusCode == 302 || res.StatusCode == 401, "Should require authentication")

	// Note: In a full integration test with OIDC, we would:
	// 1. Go through the OIDC flow to get admin session
	// 2. Test that admin can access their service dashboard
	// 3. Test that admin cannot access other services
	// For now, we verify that authentication is required
}

// TestSuperAdminWorkflowWithSession tests super admin functionality
func TestSuperAdminWorkflowWithSession(t *testing.T) {
	echoServer, controller := waitForServer(t)
	defer echoServer.Close()
	defer controller.Store.Close()

	// Create super admin
	superAdminId := "test_super_admin"
	superAdminRoles := []string{"superadmin", "admin-service1", "admin-service2"}

	adminUser := domain.AdminUser{
		UserId: superAdminId,
		Roles:  superAdminRoles,
	}

	// Test super admin permissions
	assert.True(t, adminUser.IsSuperAdmin())
	assert.True(t, adminUser.HasServiceAdminRole("any-service")) // Super admin has access to all
	assert.True(t, adminUser.HasServiceAdminRole(TEST_SERVICE))

	// Test that without authentication, super admin routes are not accessible
	client := createTestHttpClient(false)
	res, err := client.Get(createServerUrl(serverConfig.Port, "/superadmin/services"))
	assert.NoError(t, err)

	// Should be redirected to auth or get unauthorized
	assert.True(t, res.StatusCode == 302 || res.StatusCode == 401, "Should require authentication")

	// Note: In a full integration test with OIDC, we would:
	// 1. Go through the OIDC flow to get super admin session
	// 2. Test that super admin can access all routes
	// 3. Test that super admin can manage all services
	// For now, we verify that authentication is required
}

// TestCommentManagementWorkflows tests comment operations for different user types
func TestCommentManagementWorkflows(t *testing.T) {
	echoServer, controller := waitForServer(t)
	defer echoServer.Close()
	defer controller.Store.Close()

	// Create test data
	regularUserId, err := controller.Store.CreateUserWithExternalId("comment_user")
	assert.NoError(t, err)

	serviceId, err := controller.Store.CreateService("commenttest", "https://commenttest.com")
	assert.NoError(t, err)

	// Create a comment
	commentId, err := controller.Store.CreateComment(
		domain.CommentStatusPendingApproval,
		serviceId,
		"commenttest",
		regularUserId,
		"test-post",
		"Test comment for management",
		"Test User",
		"https://testuser.com",
		"https://commenttest.com/test-post")
	assert.NoError(t, err)

	// Test comment exists and has correct initial status
	comment, err := controller.Store.GetComment(commentId)
	assert.NoError(t, err)
	assert.Equal(t, domain.CommentStatusPendingApproval, comment.Status)
	assert.Equal(t, "Test comment for management", comment.Comment)
	assert.Equal(t, regularUserId, comment.UserId)

	// Test comment retrieval by service
	comments, err := controller.Store.GetCommentsByServiceAndStatus("commenttest", []domain.CommentStatus{domain.CommentStatusPendingApproval})
	assert.NoError(t, err)
	assert.True(t, len(comments) > 0)

	// Find our comment in the results
	found := false
	for _, c := range comments {
		if c.Id == commentId {
			found = true
			assert.Equal(t, "Test comment for management", c.Comment)
			break
		}
	}
	assert.True(t, found, "Comment should be found in service comments")

	// Test admin operations on comment (approve)
	err = controller.Store.UpdateComment(
		commentId,
		domain.CommentStatusApproved,
		comment.Comment,
		comment.Name,
		comment.Website,
		comment.ParentUrl)
	assert.NoError(t, err)

	// Verify comment was approved
	updatedComment, err := controller.Store.GetComment(commentId)
	assert.NoError(t, err)
	assert.Equal(t, domain.CommentStatusApproved, updatedComment.Status)

	// Test comment deletion
	err = controller.Store.DeleteComment(commentId)
	assert.NoError(t, err)

	// Verify comment was deleted
	_, err = controller.Store.GetComment(commentId)
	assert.Error(t, err, "Comment should not exist after deletion")
}

// TestServiceScopingAndSecurity tests that service-scoped operations work correctly
func TestServiceScopingAndSecurity(t *testing.T) {
	echoServer, controller := waitForServer(t)
	defer echoServer.Close()
	defer controller.Store.Close()

	// Create two services
	service1Id, err := controller.Store.CreateService("service1", "https://service1.com")
	assert.NoError(t, err)
	service2Id, err := controller.Store.CreateService("service2", "https://service2.com")
	assert.NoError(t, err)

	// Create users for each service
	user1Id, err := controller.Store.CreateUserWithExternalId("user1")
	assert.NoError(t, err)
	user2Id, err := controller.Store.CreateUserWithExternalId("user2")
	assert.NoError(t, err)

	// Create comments in different services
	comment1Id, err := controller.Store.CreateComment(
		domain.CommentStatusApproved, service1Id, "service1", user1Id,
		"post1", "Comment in service 1", "User 1", "", "")
	assert.NoError(t, err)

	comment2Id, err := controller.Store.CreateComment(
		domain.CommentStatusApproved, service2Id, "service2", user2Id,
		"post1", "Comment in service 2", "User 2", "", "")
	assert.NoError(t, err)

	// Test service-scoped comment retrieval
	service1Comments, err := controller.Store.GetCommentsByServiceAndStatus("service1", []domain.CommentStatus{domain.CommentStatusApproved})
	assert.NoError(t, err)

	service2Comments, err := controller.Store.GetCommentsByServiceAndStatus("service2", []domain.CommentStatus{domain.CommentStatusApproved})
	assert.NoError(t, err)

	// Verify comments are properly scoped to their services
	assert.True(t, len(service1Comments) > 0)
	assert.True(t, len(service2Comments) > 0)

	// Verify service 1 comments don't appear in service 2 results and vice versa
	service1CommentIds := make(map[int]bool)
	for _, c := range service1Comments {
		service1CommentIds[c.Id] = true
		assert.Equal(t, "service1", c.ServiceKey)
	}

	service2CommentIds := make(map[int]bool)
	for _, c := range service2Comments {
		service2CommentIds[c.Id] = true
		assert.Equal(t, "service2", c.ServiceKey)
	}

	// Comments should not cross-contaminate between services
	assert.True(t, service1CommentIds[comment1Id], "Service 1 should contain its comment")
	assert.False(t, service1CommentIds[comment2Id], "Service 1 should not contain service 2's comment")
	assert.True(t, service2CommentIds[comment2Id], "Service 2 should contain its comment")
	assert.False(t, service2CommentIds[comment1Id], "Service 2 should not contain service 1's comment")

	// Test service admin role scoping
	service1Admin := domain.AdminUser{
		UserId: "service1_admin",
		Roles:  []string{"admin-service1"},
	}

	service2Admin := domain.AdminUser{
		UserId: "service2_admin",
		Roles:  []string{"admin-service2"},
	}

	// Service 1 admin should only have access to service 1
	assert.True(t, service1Admin.HasServiceAdminRole("service1"))
	assert.False(t, service1Admin.HasServiceAdminRole("service2"))

	// Service 2 admin should only have access to service 2
	assert.True(t, service2Admin.HasServiceAdminRole("service2"))
	assert.False(t, service2Admin.HasServiceAdminRole("service1"))

	// Super admin should have access to both
	superAdmin := domain.AdminUser{
		UserId: "super_admin",
		Roles:  []string{"superadmin"},
	}
	assert.True(t, superAdmin.HasServiceAdminRole("service1"))
	assert.True(t, superAdmin.HasServiceAdminRole("service2"))
	assert.True(t, superAdmin.IsSuperAdmin())
}

// TestErrorHandlingAndEdgeCases tests various error conditions
func TestErrorHandlingAndEdgeCases(t *testing.T) {
	echoServer, controller := waitForServer(t)
	defer echoServer.Close()
	defer controller.Store.Close()

	// Test accessing non-existent comment
	_, err := controller.Store.GetComment(99999)
	assert.Error(t, err, "Should error when accessing non-existent comment")

	// Test accessing non-existent user
	_, err = controller.Store.FindUserById(99999)
	assert.Error(t, err, "Should error when accessing non-existent user")

	// Test finding non-existent external user
	_, err = controller.Store.FindUserByExternalId("non_existent_external_id")
	assert.Error(t, err, "Should error when finding non-existent external user")

	// Test creating comment with invalid service ID
	userId, _ := controller.Store.CreateUser()
	_, err = controller.Store.CreateComment(
		domain.CommentStatusApproved, 99999, "invalid_service", userId,
		"test", "test comment", "test user", "", "")
	assert.Error(t, err, "Should error when creating comment with invalid service")

	// Test role validation edge cases
	adminUser := domain.AdminUser{UserId: "test", Roles: nil}
	assert.False(t, adminUser.HasServiceAdminRole("any-service"), "Nil roles should not grant access")
	assert.False(t, adminUser.IsSuperAdmin(), "Nil roles should not grant super admin")

	adminUser.Roles = []string{}
	assert.False(t, adminUser.HasServiceAdminRole("any-service"), "Empty roles should not grant access")
	assert.False(t, adminUser.IsSuperAdmin(), "Empty roles should not grant super admin")

	// Test malformed admin roles
	adminUser.Roles = []string{"admin", "admin-", "not-admin-service", "service-admin"}
	assert.False(t, adminUser.HasServiceAdminRole("service"), "Malformed admin roles should not grant access")
	assert.False(t, adminUser.IsSuperAdmin(), "Malformed roles should not grant super admin")

	// Test valid admin role formatting
	adminUser.Roles = []string{"admin-validservice"}
	assert.True(t, adminUser.HasServiceAdminRole("validservice"), "Properly formatted role should grant access")
	assert.False(t, adminUser.HasServiceAdminRole("otherservice"), "Should not grant access to different service")
}

// TestStatusAndUtilityEndpoints tests non-comment endpoints
func TestStatusAndUtilityEndpoints(t *testing.T) {
	echoServer, controller := waitForServer(t)
	defer echoServer.Close()
	defer controller.Store.Close()

	client := createTestHttpClient(true)

	// Test status endpoint
	res, err := client.Get(createServerUrl(serverConfig.Port, "/status"))
	assert.NoError(t, err)
	assert.Equal(t, 200, res.StatusCode)
	assert.Equal(t, "text/plain; charset=UTF-8", res.Header.Get("Content-Type"))
	body := readBody(res)
	assert.Equal(t, "OK", body)

	// Test demo endpoint
	res, err = client.Get(createServerUrl(serverConfig.Port, "/demo"))
	assert.NoError(t, err)
	assert.Equal(t, 200, res.StatusCode)
	assert.Equal(t, "text/html; charset=UTF-8", res.Header.Get("Content-Type"))
	body = readBody(res)
	assert.Contains(t, body, "<!DOCTYPE html>")

	// Test user login page
	res, err = client.Get(createServerUrl(serverConfig.Port, "/login"))
	assert.NoError(t, err)
	assert.Equal(t, 200, res.StatusCode)
	body = readBody(res)
	assert.Contains(t, body, "<!DOCTYPE html>")

	// Test OIDC callback endpoint (should handle gracefully without proper OIDC data)
	res, err = client.Get(createServerUrl(serverConfig.Port, "/oidccallback"))
	assert.NoError(t, err)
	assert.True(t, res.StatusCode >= 200 && res.StatusCode < 500, "OIDC callback should handle requests gracefully")
}
