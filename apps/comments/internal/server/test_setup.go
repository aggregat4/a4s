package server

import (
	"aggregat4/go-commentservice/internal/domain"
	"aggregat4/go-commentservice/internal/repository"
	"net/http"
	"strconv"
	"testing"
	"time"

	"github.com/aggregat4/go-baselib/crypto"
)

var TEST_ENCRYPTIONKEY = "12345678901234567890123456789012"
var TEST_SERVICE = "TESTSERVICE"

var TEST_USER_ID_1 = 1
var TEST_USER_ID_2 = 2
var TEST_USER_ID_3 = 3

var TEST_POSTKEY1 = "TEST_POSTKEY1"
var TEST_POSTKEY2 = "TEST_POSTKEY2"
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
	SessionCookieSecureFlag:   false,
}

func waitForServer(t *testing.T) (*http.Server, *Controller) {
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
	createTestData(t, &store)
	controller := &Controller{Store: &store, Config: serverConfig}
	httpServer := InitServerWithOidcMiddleware(controller, createMockOidcMiddleware(), createMockOidcCallback(), false)
	go func() {
		_ = httpServer.ListenAndServe()
	}()
	waitForServerStart(t, createServerUrl(serverConfig.Port, "/status"))
	return httpServer, controller
}

func createTestData(t *testing.T, store *repository.Store) {
	serviceId, err := store.CreateService(TEST_SERVICE, "https://example.com")
	if err != nil {
		t.Fatal("Error creating test service: " + err.Error())
	}

	// Create test users
	testUserId1, err := store.CreateUser()
	if err != nil {
		t.Fatal("Error creating test user: " + err.Error())
	}

	// create comments
	comments := []struct {
		status  domain.CommentStatus
		comment string
	}{
		{domain.CommentStatusPendingApproval, TEST_COMMENT_PENDING_APPROVAL},
		{domain.CommentStatusApproved, TEST_COMMENT_APPROVED},
		{domain.CommentStatusRejected, TEST_COMMENT_REJECTED},
	}

	for _, c := range comments {
		commentId, err := store.CreateComment(c.status, serviceId, TEST_SERVICE, testUserId1, TEST_POSTKEY1, c.comment, TEST_AUTHOR1, TEST_WEBSITE1, "https://example.com")
		if err != nil {
			t.Fatal("Error creating test comment: " + err.Error())
		}
		TEST_COMMENTS = append(TEST_COMMENTS, domain.Comment{Id: commentId, Status: c.status, ServiceId: serviceId, UserId: testUserId1, PostKey: TEST_POSTKEY1, Comment: c.comment, Name: TEST_AUTHOR1, Website: TEST_WEBSITE1, Edited: false, CreatedAt: time.Now()})
	}
}

func createServerUrl(port int, path string) string {
	return "http://localhost:" + strconv.Itoa(port) + path
}
