package server

import (
	_ "github.com/mattn/go-sqlite3"
	"github.com/stretchr/testify/assert"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"testing"
)

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
	authenticateAndValidate(t, client, controller, TEST_USER_AUTHTOKEN_VALID, TEST_AUTHTOKEN_VALID)
}

func authenticateAndValidate(t *testing.T, client *http.Client, controller Controller, email string, token string) {
	res, err := client.Get(createServerUrl(serverConfig.Port, "/userauthentication/"+token))
	if err != nil {
		t.Fatal(err)
	}
	user, err := controller.Store.FindUserByEmail(email)
	if err != nil {
		t.Fatal(err)
	}
	assert.Equal(t, http.StatusFound, res.StatusCode)
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
	assert.Equal(t, http.StatusFound, res.StatusCode)
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
	authenticateAndValidate(t, client, controller, TEST_USER_AUTHTOKEN_VALID, TEST_AUTHTOKEN_VALID)
	expectedCommentId := findCommentByContent(TEST_COMMENTS, TEST_COMMENT_PENDING_AUTHENTICATION).Id
	res, err := client.Get(createServerUrl(serverConfig.Port, "/services/"+TEST_SERVICE+"/posts/"+TEST_POSTKEY1+"/commentform?commentId="+strconv.Itoa(expectedCommentId)))
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

func postComment(t *testing.T, client *http.Client, formParams url.Values, postKey string) *http.Response {
	encodedParams := formParams.Encode()
	postBody := strings.NewReader(encodedParams)
	res, err := client.Post(
		createServerUrl(serverConfig.Port, "/services/"+TEST_SERVICE+"/posts/"+postKey+"/comments"),
		"application/x-www-form-urlencoded",
		postBody)
	if err != nil {
		t.Fatal(err)
	}
	return res
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
	res := postComment(t, client, formParams, TEST_POSTKEY2)
	assert.Equal(t, http.StatusFound, res.StatusCode)
	assert.True(t, strings.HasPrefix(res.Header.Get("Location"), "/services/"+TEST_SERVICE+"/posts/"+TEST_POSTKEY2+"/comments"))
	checkWhetherPostHasComment(t, TEST_POSTKEY2, comment)
}

func TestPostNewCommentAuthenticated(t *testing.T) {
	echoServer, controller := waitForServer(t)
	defer echoServer.Close()
	defer controller.Store.Close()
	client := createTestHttpClient()
	authenticateAndValidate(t, client, controller, TEST_USER_AUTHTOKEN_VALID, TEST_AUTHTOKEN_VALID)
	formParams := url.Values{}
	formParams.Set("emailAddress", TEST_USER_AUTHTOKEN_VALID)
	formParams.Set("name", "John Foo")
	formParams.Set("website", "http://example.com")
	comment := "This is a comment"
	formParams.Set("comment", comment)
	res := postComment(t, client, formParams, TEST_POSTKEY2)
	assert.Equal(t, http.StatusFound, res.StatusCode)
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
	res := postComment(t, client, formParams, TEST_POSTKEY2)
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
	res := postComment(t, client, formParams, TEST_POSTKEY2)
	assert.Equal(t, 400, res.StatusCode)
}

func TestPostExistingCommentWithInvalidCommentId(t *testing.T) {
	echoServer, controller := waitForServer(t)
	defer echoServer.Close()
	defer controller.Store.Close()
	client := createTestHttpClient()
	authenticateAndValidate(t, client, controller, TEST_USER_AUTHTOKEN_VALID, TEST_AUTHTOKEN_VALID)
	formParams := url.Values{}
	formParams.Set("emailAddress", TEST_USER_AUTHTOKEN_VALID)
	formParams.Set("name", "John Foo")
	formParams.Set("website", "http://example.com")
	formParams.Set("commentId", "INVALIDCOMMENTID")
	comment := "This is a comment"
	formParams.Set("comment", comment)
	res := postComment(t, client, formParams, TEST_POSTKEY2)
	assert.Equal(t, 404, res.StatusCode)
}

func TestPostExistingCommentWithValidCommentId(t *testing.T) {
	echoServer, controller := waitForServer(t)
	defer echoServer.Close()
	defer controller.Store.Close()
	client := createTestHttpClient()
	authenticateAndValidate(t, client, controller, TEST_USER_AUTHTOKEN_VALID, TEST_AUTHTOKEN_VALID)
	expectedCommentId := findCommentByContent(TEST_COMMENTS, TEST_COMMENT_PENDING_AUTHENTICATION).Id
	formParams := url.Values{}
	formParams.Set("emailAddress", TEST_USER_AUTHTOKEN_VALID)
	formParams.Set("name", "John Foo")
	formParams.Set("website", "http://example.com")
	formParams.Set("commentId", strconv.Itoa(expectedCommentId))
	comment := "New Comment Contents"
	formParams.Set("comment", comment)
	res := postComment(t, client, formParams, TEST_POSTKEY1)
	assert.Equal(t, http.StatusFound, res.StatusCode)
	assert.True(t, strings.HasPrefix(res.Header.Get("Location"), "/services/"+TEST_SERVICE+"/posts/"+TEST_POSTKEY+"/comments"))
	checkWhetherPostHasComment(t, TEST_POSTKEY1, comment)
}

func TestPostExistingCommentWithValidCommentIdButWrongUser(t *testing.T) {
	echoServer, controller := waitForServer(t)
	defer echoServer.Close()
	defer controller.Store.Close()
	client := createTestHttpClient()
	authenticateAndValidate(t, client, controller, TEST_USER_AUTHTOKEN_VALID2, TEST_AUTHTOKEN_VALID2)
	expectedCommentId := findCommentByContent(TEST_COMMENTS, TEST_COMMENT_PENDING_AUTHENTICATION).Id
	formParams := url.Values{}
	formParams.Set("emailAddress", TEST_USER_AUTHTOKEN_VALID)
	formParams.Set("name", "John Foo")
	formParams.Set("website", "http://example.com")
	formParams.Set("commentId", strconv.Itoa(expectedCommentId))
	comment := "New Comment Contents"
	formParams.Set("comment", comment)
	res := postComment(t, client, formParams, TEST_POSTKEY1)
	assert.Equal(t, http.StatusUnauthorized, res.StatusCode)
}

func TestPostExistingCommentWithoutAuthentication(t *testing.T) {
	echoServer, controller := waitForServer(t)
	defer echoServer.Close()
	defer controller.Store.Close()
	client := createTestHttpClient()
	expectedCommentId := findCommentByContent(TEST_COMMENTS, TEST_COMMENT_PENDING_AUTHENTICATION).Id
	formParams := url.Values{}
	formParams.Set("emailAddress", TEST_USER_AUTHTOKEN_VALID)
	formParams.Set("name", "John Foo")
	formParams.Set("website", "http://example.com")
	formParams.Set("commentId", strconv.Itoa(expectedCommentId))
	comment := "Modified Comment"
	formParams.Set("comment", comment)
	res := postComment(t, client, formParams, TEST_POSTKEY2)
	assert.Equal(t, http.StatusUnauthorized, res.StatusCode)
}

func TestPostExistingCommentAsTheWrongUser(t *testing.T) {
	echoServer, controller := waitForServer(t)
	defer echoServer.Close()
	defer controller.Store.Close()
	client := createTestHttpClient()
	authenticateAndValidate(t, client, controller, TEST_USER_AUTHTOKEN_VALID2, TEST_AUTHTOKEN_VALID2)
	expectedCommentId := findCommentByContent(TEST_COMMENTS, TEST_COMMENT_PENDING_AUTHENTICATION).Id
	formParams := url.Values{}
	formParams.Set("emailAddress", TEST_USER_AUTHTOKEN_VALID2)
	formParams.Set("name", "John Foo")
	formParams.Set("website", "http://example.com")
	formParams.Set("commentId", strconv.Itoa(expectedCommentId))
	comment := "Modified Comment"
	formParams.Set("comment", comment)
	res := postComment(t, client, formParams, TEST_POSTKEY1)
	assert.Equal(t, http.StatusUnauthorized, res.StatusCode)
}
