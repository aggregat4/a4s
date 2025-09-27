package server

import (
	"bytes"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"testing"

	"aggregat4/go-commentservice/internal/domain"
	"aggregat4/go-commentservice/internal/repository"
	"github.com/aggregat4/go-baselib/crypto"
)

const (
	testEncryptionKey       = "12345678901234567890123456789012"
	testSessionCookieSecret = "testsessioncookiesecretkey"
	testServiceKey          = "TESTSERVICE"
	testServiceOrigin       = "https://example.com"
	testPostKeyApproved     = "TEST_POSTKEY1"
	testPostKeySecond       = "TEST_POSTKEY2"
	testCommentPending      = "This is an authenticated comment waiting for approval"
	testCommentApproved     = "This is an approved comment"
	testCommentRejected     = "This is a rejected comment"
	testAuthorName          = "John Doe"
	testAuthorWebsite       = "http://example.com"
)

// handlerRoundTripper lets an http.Client talk directly to a handler without sockets.
type handlerRoundTripper struct {
	handler http.Handler
}

func (rt handlerRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	var bodyCopy []byte
	if req.Body != nil {
		var err error
		bodyCopy, err = io.ReadAll(req.Body)
		if err != nil {
			return nil, err
		}
		_ = req.Body.Close()
	}

	reqClone := req.Clone(req.Context())
	if bodyCopy != nil {
		reqClone.Body = io.NopCloser(bytes.NewReader(bodyCopy))
		reqClone.ContentLength = int64(len(bodyCopy))
	} else {
		reqClone.Body = nil
		reqClone.ContentLength = 0
	}
	reqClone.RequestURI = req.URL.RequestURI()
	reqClone.Host = req.URL.Host

	recorder := httptest.NewRecorder()
	rt.handler.ServeHTTP(recorder, reqClone)
	resp := recorder.Result()
	resp.Request = req

	if bodyCopy != nil {
		req.Body = io.NopCloser(bytes.NewReader(bodyCopy))
	}

	return resp, nil
}

// ServerHarness centralizes test server setup, pre-seeded fixtures, and handy clients.
type ServerHarness struct {
	t          testing.TB
	Controller *Controller
	Server     *http.Server
	Handler    http.Handler
	Store      *repository.Store
	BaseURL    string
	Data       *BaselineData
}

type harnessConfig struct {
	seedBaseline bool
	enableCsrf   bool
}

type HarnessOption func(*harnessConfig)

// WithoutBaselineData skips inserting the default service/user/comment fixtures.
func WithoutBaselineData() HarnessOption {
	return func(cfg *harnessConfig) {
		cfg.seedBaseline = false
	}
}

// WithCsrfEnabled allows tests to opt-in to CSRF middleware checks.
func WithCsrfEnabled() HarnessOption {
	return func(cfg *harnessConfig) {
		cfg.enableCsrf = true
	}
}

// BaselineData captures the default fixtures we seed for convenience.
type BaselineData struct {
	Service        domain.Service
	PrimaryUser    domain.User
	AdditionalUser domain.User
	Comments       map[string]domain.Comment
}

// NewServerHarness creates a controller wired to an HTTP handler with optional fixtures.
func NewServerHarness(t testing.TB, opts ...HarnessOption) *ServerHarness {
	t.Helper()

	cfg := harnessConfig{seedBaseline: true}
	for _, opt := range opts {
		opt(&cfg)
	}

	cipher, err := crypto.CreateAes256GcmAead([]byte(testEncryptionKey))
	if err != nil {
		t.Fatalf("failed to create cipher: %v", err)
	}

	store := &repository.Store{Cipher: cipher}
	if err := store.InitAndVerifyDb(repository.CreateInMemoryDbUrl()); err != nil {
		t.Fatalf("failed to init in-memory db: %v", err)
	}

	controller := &Controller{
		Store: store,
		Config: domain.Config{
			Port:                      8080,
			DatabaseFilename:          "",
			BaseURL:                   "http://localhost:8080",
			ServerReadTimeoutSeconds:  50,
			ServerWriteTimeoutSeconds: 100,
			OidcIdpServer:             "",
			OidcClientId:              "",
			OidcClientSecret:          "",
			OidcRedirectUri:           "",
			EncryptionKey:             "testencryptionkey",
			SessionCookieSecretKey:    testSessionCookieSecret,
			SessionCookieSecureFlag:   false,
		},
	}

	server := InitServerWithOidcMiddleware(controller, noopOidcMiddleware, noopOidcCallback, cfg.enableCsrf)

	harness := &ServerHarness{
		t:          t,
		Controller: controller,
		Server:     server,
		Handler:    server.Handler,
		Store:      store,
		BaseURL:    "http://localhost:8080",
	}

	if cfg.seedBaseline {
		data := harness.seedBaselineData()
		harness.Data = &data
	}

	t.Cleanup(func() {
		_ = harness.Close()
	})

	return harness
}

// Close releases DB connections; the HTTP server was never started so Close is a no-op.
func (h *ServerHarness) Close() error {
	if h.Store != nil {
		_ = h.Store.Close()
	}
	return nil
}

// NewClient returns an http.Client that uses the harness handler directly.
func (h *ServerHarness) NewClient(followRedirects bool) *http.Client {
	jar, _ := cookiejar.New(nil)
	client := &http.Client{
		Jar:       jar,
		Transport: handlerRoundTripper{handler: h.Handler},
	}
	if !followRedirects {
		client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		}
	}
	return client
}

// MustUserSessionCookie returns a session cookie authenticating as the given user ID.
func (h *ServerHarness) MustUserSessionCookie(userID int) *http.Cookie {
	req := httptest.NewRequest(http.MethodGet, h.BaseURL, nil)
	sess, err := h.Controller.getSession(req)
	if err != nil {
		h.t.Fatalf("getSession failed: %v", err)
	}
	sess.Values["userid"] = userID

	recorder := httptest.NewRecorder()
	if err := sess.Save(req, recorder); err != nil {
		h.t.Fatalf("failed to persist user session: %v", err)
	}

	for _, cookie := range recorder.Result().Cookies() {
		if cookie.Name == authenticatedUserCookieName {
			return cookie
		}
	}

	h.t.Fatalf("expected session cookie %s to be created", authenticatedUserCookieName)
	return nil
}

// MustAdminSessionCookie returns an admin session cookie seeded with the provided roles.
func (h *ServerHarness) MustAdminSessionCookie(adminID string, roles []string) *http.Cookie {
	req := httptest.NewRequest(http.MethodGet, h.BaseURL, nil)
	sess, err := h.Controller.getSession(req)
	if err != nil {
		h.t.Fatalf("getSession failed: %v", err)
	}
	sess.Values["adminuserid"] = adminID
	sess.Values["adminroles"] = roles

	recorder := httptest.NewRecorder()
	if err := sess.Save(req, recorder); err != nil {
		h.t.Fatalf("failed to persist admin session: %v", err)
	}

	for _, cookie := range recorder.Result().Cookies() {
		if cookie.Name == authenticatedUserCookieName {
			return cookie
		}
	}

	h.t.Fatalf("expected admin session cookie %s to be created", authenticatedUserCookieName)
	return nil
}

// SetCookie places a cookie into the client's jar for the harness base URL.
func (h *ServerHarness) SetCookie(client *http.Client, cookie *http.Cookie) {
	base, err := url.Parse(h.BaseURL)
	if err != nil {
		h.t.Fatalf("failed to parse base url: %v", err)
	}
	cookies := client.Jar.Cookies(base)
	filtered := make([]*http.Cookie, 0, len(cookies)+1)
	for _, c := range cookies {
		if c.Name != cookie.Name {
			filtered = append(filtered, c)
		}
	}
	filtered = append(filtered, cookie)
	client.Jar.SetCookies(base, filtered)
}

// URL builds a request URL relative to the harness base.
func (h *ServerHarness) URL(path string) string {
	return h.BaseURL + path
}

func (h *ServerHarness) seedBaselineData() BaselineData {
	serviceID, err := h.Store.CreateService(testServiceKey, testServiceOrigin)
	if err != nil {
		h.t.Fatalf("failed to seed service: %v", err)
	}

	primaryUserID, err := h.Store.CreateUser()
	if err != nil {
		h.t.Fatalf("failed to seed primary user: %v", err)
	}

	secondaryUserID, err := h.Store.CreateUser()
	if err != nil {
		h.t.Fatalf("failed to seed secondary user: %v", err)
	}

	comments := map[string]domain.Comment{}

	commentFixtures := []struct {
		key     string
		status  domain.CommentStatus
		message string
	}{
		{"pending", domain.CommentStatusPendingApproval, testCommentPending},
		{"approved", domain.CommentStatusApproved, testCommentApproved},
		{"rejected", domain.CommentStatusRejected, testCommentRejected},
	}

	for _, fixture := range commentFixtures {
		commentID, err := h.Store.CreateComment(
			fixture.status,
			serviceID,
			testServiceKey,
			primaryUserID,
			testPostKeyApproved,
			fixture.message,
			testAuthorName,
			testAuthorWebsite,
			testServiceOrigin,
		)
		if err != nil {
			h.t.Fatalf("failed to seed %s comment: %v", fixture.key, err)
		}

		comment, err := h.Store.GetComment(commentID)
		if err != nil {
			h.t.Fatalf("failed to reload %s comment: %v", fixture.key, err)
		}
		comments[fixture.key] = comment
	}

	return BaselineData{
		Service: domain.Service{Id: serviceID, ServiceKey: testServiceKey, Origin: testServiceOrigin},
		PrimaryUser: domain.User{
			Id: primaryUserID,
		},
		AdditionalUser: domain.User{
			Id: secondaryUserID,
		},
		Comments: comments,
	}
}

func noopOidcCallback(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
}

func noopOidcMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r)
	})
}

// readBody is a small helper for assertions.
func readBody(res *http.Response) string {
	body, err := io.ReadAll(res.Body)
	if err != nil {
		panic(err)
	}
	defer res.Body.Close()
	return string(body)
}
