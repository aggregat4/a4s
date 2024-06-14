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
)

var TEST_ENCRYPTIONKEY = "12345678901234567890123456789012"
var TEST_SERVICE = "TESTSERVICE"

var TEST_USER1_EMAIL = "johndoe@example.com"
var TEST_POSTKEY1 = "TEST_POSTKEY1"
var TEST_COMMENT1 = "This is comment 1"
var TEST_AUTHOR1 = "John Doe"
var TEST_WEBSITE1 = "http://example.com"

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
	res, err := http.Get(createServerUrl(serverConfig.Port, "/services/"+TEST_SERVICE+"/posts/"+TEST_POSTKEY1+"/comments"))
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
	assert.Contains(t, body, "<dd>"+TEST_COMMENT1)
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
}

func TestRequestAuthenticationLinkWithExistingEmailParam(t *testing.T) {
	echoServer, controller := waitForServer(t)
	defer echoServer.Close()
	defer controller.Store.Close()
	formParams := url.Values{}
	formParams.Set("email", TEST_USER1_EMAIL)
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
	userId, err := store.CreateUser(TEST_USER1_EMAIL)
	if err != nil {
		t.Fatal("Error creating test user: " + err.Error())
	}
	_, err = store.CreateComment(serviceId, userId, TEST_POSTKEY1, TEST_COMMENT1, TEST_AUTHOR1, TEST_WEBSITE1)
	if err != nil {
		t.Fatal("Error creating test comment: " + err.Error())
	}
}

func createServerUrl(port int, path string) string {
	return "http://localhost:" + strconv.Itoa(port) + path
}
