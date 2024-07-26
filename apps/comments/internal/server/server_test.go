package server

import (
	"aggregat4/go-commentservice/internal/domain"
	"aggregat4/go-commentservice/internal/email"
	"aggregat4/go-commentservice/internal/repository"
	"github.com/aggregat4/go-baselib/crypto"
	"github.com/labstack/echo/v4"
	_ "github.com/mattn/go-sqlite3"
	"github.com/stretchr/testify/assert"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"
)

var TEST_ENCRYPTIONKEY = "12345678901234567890123456789012"
var TEST_SERVICE = "TESTSERVICE"

var TEST_USER_NO_TOKEN = "notoken@example.com"

var TEST_USER_AUTHTOKEN_EXPIRED = "expired@example.com"
var TEST_AUTHTOKEN_EXPIRED = "EXPIREDTOKEN"

var TEST_USER_AUTHTOKEN_VALID = "validtoken@example.com"
var TEST_AUTHTOKEN_VALID = "VALIDTOKEN"

var TEST_POSTKEY1 = "TEST_POSTKEY1"
var TEST_POSTKEY2 = "TEST_POSTKEY2"
var TEST_COMMENT_PENDING_AUTHENTICATION = "This is an unauthenticated comment"
var TEST_COMMENT_PENDING_APPROVAL = "This is an authenticated comment waiting for approval"
var TEST_COMMENT_APPROVED = "This is an approved comment"
var TEST_COMMENT_REJECTED = "This is a rejected comment"
var TEST_AUTHOR1 = "John Doe"
var TEST_WEBSITE1 = "http://example.com"

var TEST_COMMENTS []domain.Comment

var serverConfig = domain.Config{
	Port:                      8080,
	DatabaseFilename:          "",
	ServerReadTimeoutSeconds:  50,
	ServerWriteTimeoutSeconds: 100,
	OidcIdpServer:             "",
	OidcClientId:              "",
	OidcClientSecret:          "",
	OidcRedirectUri:           "",
	EncryptionKey:             "testencryptionkey",
	SessionCookieSecretKey:    "testsessioncookiesecretkey",
}

func TestStatus(t *testing.T) {
	echoServer, controller := waitForServer(t)
	defer echoServer.Close()
	defer controller.Store.Close()
	res, err := http.Get(createServerUrl(serverConfig.Port, "/status"))
	if err != nil {
		t.Fatal(err)
	}
	assert.Equal(t, 200, res.StatusCode)
	assert.Equal(t, "text/plain; charset=UTF-8", res.Header.Get("Content-Type"))
	body := readBody(res)
	assert.Equal(t, "OK", body)
}

func TestInvalidService(t *testing.T) {
	echoServer, controller := waitForServer(t)
	defer echoServer.Close()
	defer controller.Store.Close()
	res, err := http.Get(createServerUrl(serverConfig.Port, "/services/foo/posts/bar/comments"))
	if err != nil {
		t.Fatal(err)
	}
	assert.Equal(t, 404, res.StatusCode)
}

func TestEmptyCommentsPage(t *testing.T) {
	echoServer, controller := waitForServer(t)
	defer echoServer.Close()
	defer controller.Store.Close()
	res, err := http.Get(createServerUrl(serverConfig.Port, "/services/"+TEST_SERVICE+"/posts/bar/comments"))
	if err != nil {
		t.Fatal(err)
	}
	assert.Equal(t, 200, res.StatusCode)
	assert.Equal(t, "text/html; charset=UTF-8", res.Header.Get("Content-Type"))
	//assert.Equal(t, "no-store", res.Header.Get("Cache-Control"))
	//assert.Contains(t, readBody(res), fmt.Sprintf("value=\"%s\"", TestState))
	body := readBody(res)
	assert.Contains(t, body, "<h1>Comments</h1>")
	assert.Contains(t, body, "<dl class=\"comments\">")
	assert.NotContains(t, body, "<dt>")
	assert.NotContains(t, body, "<dd>")
}

func TestSingleCommentPostPage(t *testing.T) {
	echoServer, controller := waitForServer(t)
	defer echoServer.Close()
	defer controller.Store.Close()
	checkWhetherPostHasComment(t, TEST_POSTKEY1, TEST_COMMENT_PENDING_AUTHENTICATION)
}

func checkWhetherPostHasComment(t *testing.T, postKey string, comment string) {
	res, err := http.Get(createServerUrl(serverConfig.Port, "/services/"+TEST_SERVICE+"/posts/"+postKey+"/comments"))
	if err != nil {
		t.Fatal(err)
	}
	assert.Equal(t, 200, res.StatusCode)
	assert.Equal(t, "text/html; charset=UTF-8", res.Header.Get("Content-Type"))
	//assert.Equal(t, "no-store", res.Header.Get("Cache-Control"))
	//assert.Contains(t, readBody(res), fmt.Sprintf("value=\"%s\"", TestState))
	body := readBody(res)
	assert.Contains(t, body, "<h1>Comments</h1>")
	assert.Contains(t, body, "<dl class=\"comments\">")
	assert.Contains(t, body, "<dt>")
	assert.Contains(t, body, "<dd>"+comment)
}

func TestUserAuthenticationForm(t *testing.T) {
	echoServer, controller := waitForServer(t)
	defer echoServer.Close()
	defer controller.Store.Close()
	res, err := http.Get(createServerUrl(serverConfig.Port, "/userauthentication/"))
	if err != nil {
		t.Fatal(err)
	}
	assert.Equal(t, 200, res.StatusCode)
	assert.Equal(t, "text/html; charset=UTF-8", res.Header.Get("Content-Type"))
	body := readBody(res)
	assert.Contains(t, body, "<h1>Request Authentication Token</h1>")
	assert.Contains(t, body, "<form action=\"/userauthentication/\" method=\"POST\">")
}

func TestRequestAuthenticationLinkWithNoParams(t *testing.T) {
	echoServer, controller := waitForServer(t)
	defer echoServer.Close()
	defer controller.Store.Close()
	res, err := http.Post(createServerUrl(serverConfig.Port, "/userauthentication"), "application/x-www-form-urlencoded", nil)
	if err != nil {
		t.Fatal(err)
	}
	assert.Equal(t, 400, res.StatusCode)
	assert.Equal(t, "text/html; charset=UTF-8", res.Header.Get("Content-Type"))
}

func TestRequestAuthenticationLinkWithNonExistingEmailParam(t *testing.T) {
	echoServer, controller := waitForServer(t)
	defer echoServer.Close()
	defer controller.Store.Close()
	formParams := url.Values{}
	formParams.Set("email", "foo@example.com")
	encodedParams := formParams.Encode()
	postBody := strings.NewReader(encodedParams)
	res, err := http.Post(
		createServerUrl(serverConfig.Port, "/userauthentication"),
		"application/x-www-form-urlencoded",
		postBody)
	if err != nil {
		t.Fatal(err)
	}
	assert.Equal(t, 200, res.StatusCode)
	assert.Equal(t, "text/html; charset=UTF-8", res.Header.Get("Content-Type"))
	body := readBody(res)
	assert.Contains(t, body, "<h1>Request Authentication Token</h1>")
	assert.Contains(t, body, "<p class=\"error\">")
	assert.Equal(t, 0, controller.EmailSender.NumberOfEmailsSent, "EmailSender should NOT have been called")
}

func TestRequestAuthenticationLinkWithExistingEmailParam(t *testing.T) {
	echoServer, controller := waitForServer(t)
	defer echoServer.Close()
	defer controller.Store.Close()
	formParams := url.Values{}
	formParams.Set("email", TEST_USER_NO_TOKEN)
	encodedParams := formParams.Encode()
	postBody := strings.NewReader(encodedParams)
	res, err := http.Post(
		createServerUrl(serverConfig.Port, "/userauthentication"),
		"application/x-www-form-urlencoded",
		postBody)
	if err != nil {
		t.Fatal(err)
	}
	assert.Equal(t, 200, res.StatusCode)
	assert.Equal(t, "text/html; charset=UTF-8", res.Header.Get("Content-Type"))
	body := readBody(res)
	assert.Contains(t, body, "<h1>Request Authentication Token</h1>")
	assert.Contains(t, body, "<p class=\"success\">")
	assert.Contains(t, body, "An authentication token will be sent")
	assert.Equal(t, 1, controller.EmailSender.NumberOfEmailsSent, "EmailSender should have been called")
}

func TestUserAuthenticationWithUnknownToken(t *testing.T) {
	echoServer, controller := waitForServer(t)
	defer echoServer.Close()
	defer controller.Store.Close()
	res, err := http.Get(createServerUrl(serverConfig.Port, "/userauthentication/INVALIDTOKEN"))
	if err != nil {
		t.Fatal(err)
	}
	assert.Equal(t, 200, res.StatusCode)
	assert.Equal(t, "text/html; charset=UTF-8", res.Header.Get("Content-Type"))
	body := readBody(res)
	assert.Contains(t, body, "<h1>Request Authentication Token</h1>")
	assert.Contains(t, body, "<p class=\"error\">")
	assert.Contains(t, body, "Invalid token")
}

func TestUserAuthenticationValidToken(t *testing.T) {
	echoServer, controller := waitForServer(t)
	defer echoServer.Close()
	defer controller.Store.Close()
	client := createTestHttpClient()
	authenticateAndValidate(t, client, controller)
}

func authenticateAndValidate(t *testing.T, client *http.Client, controller Controller) {
	res, err := client.Get(createServerUrl(serverConfig.Port, "/userauthentication/"+TEST_AUTHTOKEN_VALID))
	if err != nil {
		t.Fatal(err)
	}
	user, err := controller.Store.FindUserByEmail(TEST_USER_AUTHTOKEN_VALID)
	if err != nil {
		t.Fatal(err)
	}
	assert.Equal(t, 302, res.StatusCode)
	assert.Equal(t, "/users/"+strconv.Itoa(user.Id)+"/comments", res.Header.Get("Location"))
}

func TestUserAuthenticationExpiredToken(t *testing.T) {
	echoServer, controller := waitForServer(t)
	defer echoServer.Close()
	defer controller.Store.Close()
	client := createTestHttpClient()
	res, err := client.Get(createServerUrl(serverConfig.Port, "/userauthentication/"+TEST_AUTHTOKEN_EXPIRED))
	if err != nil {
		t.Fatal(err)
	}
	assert.Equal(t, 302, res.StatusCode)
	assert.Equal(t, "/userauthentication/?error=Invalid+token", res.Header.Get("Location"))
}

func TestGetCommentForm(t *testing.T) {
	echoServer, controller := waitForServer(t)
	defer echoServer.Close()
	defer controller.Store.Close()
	res, err := http.Get(createServerUrl(serverConfig.Port, "/services/"+TEST_SERVICE+"/posts/"+TEST_POSTKEY1+"/commentform"))
	if err != nil {
		t.Fatal(err)
	}
	assert.Equal(t, 200, res.StatusCode)
	assert.Equal(t, "text/html; charset=UTF-8", res.Header.Get("Content-Type"))
	body := readBody(res)
	assert.Contains(t, body, "<title>New Comment</title>")
	assert.Contains(t, body, "<h1>New Comment</h1>")
	assert.Contains(t, body, "<form method=\"POST\" action=\"/services/"+TEST_SERVICE+"/posts/"+TEST_POSTKEY1+"/comments\">")
}

func TestGetCommentFormWithExistingComment(t *testing.T) {
	echoServer, controller := waitForServer(t)
	defer echoServer.Close()
	defer controller.Store.Close()
	client := createTestHttpClient()
	res, err := client.Get(createServerUrl(serverConfig.Port, "/userauthentication/"+TEST_AUTHTOKEN_VALID))
	if err != nil {
		t.Fatal(err)
	}
	expectedCommentId := findCommentByContent(TEST_COMMENTS, TEST_COMMENT_PENDING_AUTHENTICATION).Id
	// TODO: figure out why we get a 400 for this request, but we don't actually get to the comment form code
	res, err = client.Get(createServerUrl(serverConfig.Port, "/services/"+TEST_SERVICE+"/posts/"+TEST_POSTKEY1+"/commentform?commentId="+strconv.Itoa(expectedCommentId)))
	if err != nil {
		t.Fatal(err)
	}
	assert.Equal(t, 200, res.StatusCode)
	assert.Equal(t, "text/html; charset=UTF-8", res.Header.Get("Content-Type"))
	body := readBody(res)
	assert.Contains(t, body, "<title>Edit Comment</title>")
	assert.Contains(t, body, "<h1>Edit Comment</h1>")
	assert.Contains(t, body, "<form method=\"POST\" action=\"/services/"+TEST_SERVICE+"/posts/"+TEST_POSTKEY1+"/comments\">")
	assert.Contains(t, body, "<input type=\"hidden\" name=\"commentId\" value=\""+strconv.Itoa(expectedCommentId)+"\">")
}

func TestPostNewCommentUnauthenticated(t *testing.T) {
	echoServer, controller := waitForServer(t)
	defer echoServer.Close()
	defer controller.Store.Close()
	client := createTestHttpClient()
	formParams := url.Values{}
	formParams.Set("emailAddress", "foo@example.com")
	formParams.Set("name", "John Foo")
	formParams.Set("website", "http://example.com")
	comment := "This is a comment"
	formParams.Set("comment", comment)
	res := postComment(t, client, formParams)
	assert.Equal(t, 302, res.StatusCode)
	assert.True(t, strings.HasPrefix(res.Header.Get("Location"), "/services/"+TEST_SERVICE+"/posts/"+TEST_POSTKEY2+"/comments"))
	checkWhetherPostHasComment(t, TEST_POSTKEY2, comment)
}

func postComment(t *testing.T, client *http.Client, formParams url.Values) *http.Response {
	encodedParams := formParams.Encode()
	postBody := strings.NewReader(encodedParams)
	res, err := client.Post(
		createServerUrl(serverConfig.Port, "/services/"+TEST_SERVICE+"/posts/"+TEST_POSTKEY2+"/comments"),
		"application/x-www-form-urlencoded",
		postBody)
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func TestPostNewCommentAuthenticated(t *testing.T) {
	echoServer, controller := waitForServer(t)
	defer echoServer.Close()
	defer controller.Store.Close()
	client := createTestHttpClient()
	authenticateAndValidate(t, client, controller)
	formParams := url.Values{}
	formParams.Set("emailAddress", TEST_USER_AUTHTOKEN_VALID)
	formParams.Set("name", "John Foo")
	formParams.Set("website", "http://example.com")
	comment := "This is a comment"
	formParams.Set("comment", comment)
	res := postComment(t, client, formParams)
	assert.Equal(t, 302, res.StatusCode)
	assert.True(t, strings.HasPrefix(res.Header.Get("Location"), "/services/"+TEST_SERVICE+"/posts/"+TEST_POSTKEY2+"/comments"))
	checkWhetherPostHasComment(t, TEST_POSTKEY2, comment)
}

func TestPostNewCommentWithMissingEmail(t *testing.T) {
	echoServer, controller := waitForServer(t)
	defer echoServer.Close()
	defer controller.Store.Close()
	client := createTestHttpClient()
	formParams := url.Values{}
	formParams.Set("name", "John Foo")
	formParams.Set("website", "http://example.com")
	comment := "This is a comment"
	formParams.Set("comment", comment)
	res := postComment(t, client, formParams)
	assert.Equal(t, 400, res.StatusCode)
}

func TestPostNewCommentWithMissingComment(t *testing.T) {
	echoServer, controller := waitForServer(t)
	defer echoServer.Close()
	defer controller.Store.Close()
	client := createTestHttpClient()
	formParams := url.Values{}
	formParams.Set("emailAddress", "foo@example.com")
	formParams.Set("name", "John Foo")
	formParams.Set("website", "http://example.com")
	res := postComment(t, client, formParams)
	assert.Equal(t, 400, res.StatusCode)
}

func TestPostExistingCommentWithInvalidCommnentId(t *testing.T) {
	echoServer, controller := waitForServer(t)
	defer echoServer.Close()
	defer controller.Store.Close()
	client := createTestHttpClient()
	authenticateAndValidate(t, client, controller)
	formParams := url.Values{}
	formParams.Set("emailAddress", TEST_USER_AUTHTOKEN_VALID)
	formParams.Set("name", "John Foo")
	formParams.Set("website", "http://example.com")
	formParams.Set("commentId", "INVALIDCOMMENTID")
	comment := "This is a comment"
	formParams.Set("comment", comment)
	res := postComment(t, client, formParams)
	assert.Equal(t, 404, res.StatusCode)
}

func TestPostExistingCommentWithoutAuthentication(t *testing.T) {
	// TODO: actually implement this test by first posting a comment and then trying to edit it with a wrong comment id
}

func findCommentByContent(comments []domain.Comment, content string) domain.Comment {
	for _, c := range comments {
		if c.Comment == content {
			return c
		}
	}
	return domain.Comment{}
}

func waitForServer(t *testing.T) (*echo.Echo, Controller) {
	aesCipher, err := crypto.CreateAes256GcmAead([]byte(TEST_ENCRYPTIONKEY))
	if err != nil {
		panic(err)
	}
	var store = repository.Store{
		Cipher: aesCipher,
	}
	err = store.InitAndVerifyDb(repository.CreateInMemoryDbUrl())
	if err != nil {
		panic(err)
	}
	createTestData(t, store)
	mockEmailSender := email.NewMockEmailSender()
	controller := Controller{&store, serverConfig, email.NewEmailSender(mockEmailSender.MockEmailSenderStrategy)}
	echoServer := InitServerWithOidcMiddleware(controller, createMockOidcMiddleware(), createMockOidcCallback())
	go func() {
		_ = echoServer.Start(":" + strconv.Itoa(serverConfig.Port))
	}()
	waitForServerStart(t, createServerUrl(serverConfig.Port, "/status"))
	return echoServer, controller
}

func createTestData(t *testing.T, store repository.Store) {
	serviceId, err := store.CreateService(TEST_SERVICE, "example.com")
	if err != nil {
		t.Fatal("Error creating test service: " + err.Error())
	}
	userId, err := store.CreateUserByEmail(TEST_USER_NO_TOKEN)
	if err != nil {
		t.Fatal("Error creating test user: " + err.Error())
	}
	testUserExpiredTokenId, err := store.CreateUserByEmail(TEST_USER_AUTHTOKEN_EXPIRED)
	if err != nil {
		t.Fatal("Error creating test user: " + err.Error())
	}
	expiredUser := domain.User{
		Id:                    testUserExpiredTokenId,
		Email:                 TEST_USER_AUTHTOKEN_EXPIRED,
		AuthToken:             TEST_AUTHTOKEN_EXPIRED,
		AuthTokenCreatedAt:    time.Now().Add(-20 * time.Minute),
		AuthTokenSentToClient: 0,
	}
	err = store.UpdateUser(expiredUser)
	if err != nil {
		t.Fatal("Error creating test user: " + err.Error())
	}
	testUserValidTokenId, err := store.CreateUserByEmail(TEST_USER_AUTHTOKEN_VALID)
	if err != nil {
		t.Fatal("Error creating test user: " + err.Error())
	}
	validTokenUser := domain.User{
		Id:                    testUserValidTokenId,
		Email:                 TEST_USER_AUTHTOKEN_VALID,
		AuthToken:             TEST_AUTHTOKEN_VALID,
		AuthTokenCreatedAt:    time.Now().Add(-1 * time.Minute),
		AuthTokenSentToClient: 0,
	}
	err = store.UpdateUser(validTokenUser)
	if err != nil {
		t.Fatal("Error creating test user: " + err.Error())
	}
	comments := []struct {
		status  domain.CommentStatus
		comment string
	}{
		{domain.PendingAuthentication, TEST_COMMENT_PENDING_AUTHENTICATION},
		{domain.PendingApproval, TEST_COMMENT_PENDING_APPROVAL},
		{domain.Approved, TEST_COMMENT_APPROVED},
		{domain.Rejected, TEST_COMMENT_REJECTED},
	}

	for _, c := range comments {
		commentId, err := store.CreateComment(c.status, serviceId, userId, TEST_POSTKEY1, c.comment, TEST_AUTHOR1, TEST_WEBSITE1)
		if err != nil {
			t.Fatal("Error creating test comment: " + err.Error())
		}
		TEST_COMMENTS = append(TEST_COMMENTS, domain.Comment{Id: commentId, Status: c.status, ServiceId: serviceId, UserId: userId, PostKey: TEST_POSTKEY1, Comment: c.comment, Name: TEST_AUTHOR1, Website: TEST_WEBSITE1, Edited: false, CreatedAt: time.Now()})
	}
}

func createServerUrl(port int, path string) string {
	return "http://localhost:" + strconv.Itoa(port) + path
}
