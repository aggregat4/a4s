package server

import (
	"aggregat4/go-commentservice/internal/domain"
	"aggregat4/go-commentservice/internal/email"
	"aggregat4/go-commentservice/internal/repository"
	"github.com/aggregat4/go-baselib/crypto"
	"github.com/labstack/echo/v4"
	"strconv"
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

var TEST_USER_AUTHTOKEN_VALID2 = "validtoken2@example.com"
var TEST_AUTHTOKEN_VALID2 = "VALIDTOKEN2"

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
	_, err = store.CreateUserByEmail(TEST_USER_NO_TOKEN)
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
	// create first user with a valid token
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
	// create second user with a valid token
	testUserValidTokenId2, err := store.CreateUserByEmail(TEST_USER_AUTHTOKEN_VALID2)
	if err != nil {
		t.Fatal("Error creating test user: " + err.Error())
	}
	validTokenUser2 := domain.User{
		Id:                    testUserValidTokenId2,
		Email:                 TEST_USER_AUTHTOKEN_VALID2,
		AuthToken:             TEST_AUTHTOKEN_VALID2,
		AuthTokenCreatedAt:    time.Now().Add(-1 * time.Minute),
		AuthTokenSentToClient: 0,
	}
	err = store.UpdateUser(validTokenUser2)
	if err != nil {
		t.Fatal("Error creating test user: " + err.Error())
	}
	// create comments
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
		commentId, err := store.CreateComment(c.status, serviceId, testUserValidTokenId, TEST_POSTKEY1, c.comment, TEST_AUTHOR1, TEST_WEBSITE1)
		if err != nil {
			t.Fatal("Error creating test comment: " + err.Error())
		}
		TEST_COMMENTS = append(TEST_COMMENTS, domain.Comment{Id: commentId, Status: c.status, ServiceId: serviceId, UserId: testUserValidTokenId, PostKey: TEST_POSTKEY1, Comment: c.comment, Name: TEST_AUTHOR1, Website: TEST_WEBSITE1, Edited: false, CreatedAt: time.Now()})
	}
}

func createServerUrl(port int, path string) string {
	return "http://localhost:" + strconv.Itoa(port) + path
}
