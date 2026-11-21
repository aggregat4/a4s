package main

// End-to-end tests of the bookmarks server: they build the real bmserver
// binary, start it against a mock OpenID provider and drive it over HTTP as a
// browser would, logging in through the provider and keeping cookies.

import (
	"bytes"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aggregat4/a4s/pkg/testing/oidcmock"
	"github.com/stretchr/testify/require"
)

var (
	buildOnce sync.Once
	binary    string
	buildErr  error
)

// serverBinary builds bmserver once per test run.
func serverBinary(t *testing.T) string {
	t.Helper()
	buildOnce.Do(func() {
		dir, err := os.MkdirTemp("", "bmserver-e2e")
		if err != nil {
			buildErr = err
			return
		}
		binary = filepath.Join(dir, "bmserver")
		out, err := exec.Command("go", "build", "-tags=fts5", "-o", binary, ".").CombinedOutput()
		if err != nil {
			buildErr = fmt.Errorf("go build: %v\n%s", err, out)
		}
	})
	require.NoError(t, buildErr)
	return binary
}

func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

// syncBuffer collects the server's output, which is shown when a test fails.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

type app struct {
	baseURL string
}

func (a app) url(path string) string { return a.baseURL + path }

// startApp starts bmserver with a fresh database and its own OpenID provider.
func startApp(t *testing.T) app {
	t.Helper()
	bin := serverBinary(t)
	port := freePort(t)
	baseURL := fmt.Sprintf("http://localhost:%d", port)
	idp, err := oidcmock.Run("bookmarks", "secret", baseURL+"/oidccallback", nil, "")
	require.NoError(t, err)
	t.Cleanup(idp.Close)

	cmd := exec.Command(bin)
	cmd.Dir = t.TempDir()
	cmd.Env = append(os.Environ(),
		"DELBM_DB_FILENAME="+filepath.Join(cmd.Dir, "bookmarks.sqlite"),
		"DELBM_OIDC_IDP_SERVER="+idp.Issuer(),
		"DELBM_OIDC_CLIENT_ID=bookmarks",
		"DELBM_OIDC_CLIENT_SECRET=secret",
		"DELBM_OIDC_REDIRECT_URI="+baseURL+"/oidccallback",
		"DELBM_BASE_URL="+baseURL,
		"DELBM_SERVER_PORT="+fmt.Sprint(port),
		"DELBM_SESSION_COOKIE_SECRET_KEY=e2e-session-secret-0123456789abcdef",
		"DELBM_FEED_CRAWLING_INTERVAL_SECONDS=3600",
	)
	output := &syncBuffer{}
	cmd.Stdout = output
	cmd.Stderr = output
	require.NoError(t, cmd.Start())
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		if t.Failed() {
			t.Logf("bmserver output:\n%s", output.String())
		}
	})

	deadline := time.Now().Add(10 * time.Second)
	for {
		conn, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", port))
		if err == nil {
			conn.Close()
			break
		}
		require.True(t, time.Now().Before(deadline), "bmserver did not start:\n%s", output.String())
		time.Sleep(50 * time.Millisecond)
	}
	return app{baseURL: baseURL}
}

// newClient returns a browser-like client that keeps cookies but does not
// follow redirects, so each one can be checked.
func newClient(t *testing.T) *http.Client {
	t.Helper()
	jar, err := cookiejar.New(nil)
	require.NoError(t, err)
	return &http.Client{
		Jar:     jar,
		Timeout: 10 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

func follow(t *testing.T, client *http.Client, res *http.Response) *http.Response {
	t.Helper()
	for res.StatusCode == http.StatusFound {
		location, err := res.Location()
		require.NoError(t, err)
		res.Body.Close()
		res, err = client.Get(location.String())
		require.NoError(t, err)
	}
	return res
}

func body(t *testing.T, res *http.Response) string {
	t.Helper()
	defer res.Body.Close()
	b, err := io.ReadAll(res.Body)
	require.NoError(t, err)
	return string(b)
}

// login opens path, logs in through the OpenID provider and returns the
// page the server sends back to.
func login(t *testing.T, a app, client *http.Client, path string) *http.Response {
	t.Helper()
	res, err := client.Get(a.url(path))
	require.NoError(t, err)
	require.Equal(t, http.StatusFound, res.StatusCode)
	return follow(t, client, res)
}

// post submits a form as the page itself would, from the app's own origin.
func post(t *testing.T, a app, client *http.Client, path string, form url.Values, origin string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, a.url(path), strings.NewReader(form.Encode()))
	require.NoError(t, err)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	res, err := client.Do(req)
	require.NoError(t, err)
	return res
}

func TestUnauthenticatedRequestRedirectsToTheProvider(t *testing.T) {
	a := startApp(t)
	client := newClient(t)

	res, err := client.Get(a.url("/bookmarks"))
	require.NoError(t, err)
	res.Body.Close()

	require.Equal(t, http.StatusFound, res.StatusCode)
	location, err := res.Location()
	require.NoError(t, err)
	require.Equal(t, "/auth", location.Path)
	require.Equal(t, "bookmarks", location.Query().Get("client_id"))
	require.NotEmpty(t, location.Query().Get("state"))
}

func TestLoginReturnsToTheRequestedPage(t *testing.T) {
	a := startApp(t)
	client := newClient(t)

	res := login(t, a, client, "/addbookmark?url=https%3A%2F%2Fexample.org%2Fpage&title=Example+page")

	require.Equal(t, http.StatusOK, res.StatusCode)
	page := body(t, res)
	require.Contains(t, page, "https://example.org/page")
	require.Contains(t, page, "Example page")
}

func TestCallbackWithAForeignStateIsRejected(t *testing.T) {
	a := startApp(t)
	client := newClient(t)
	res, err := client.Get(a.url("/bookmarks"))
	require.NoError(t, err)
	res.Body.Close()

	res, err = client.Get(a.url("/oidccallback?code=whatever&state=forged"))
	require.NoError(t, err)
	res.Body.Close()
	require.Equal(t, http.StatusUnauthorized, res.StatusCode)
}

func TestAddListAndDeleteABookmark(t *testing.T) {
	a := startApp(t)
	client := newClient(t)
	body(t, login(t, a, client, "/bookmarks"))

	res := post(t, a, client, "/bookmarks", url.Values{
		"url":         {"https://example.org/go"},
		"title":       {"Learning Go"},
		"description": {"A tour"},
		"tags":        {"go,learning"},
	}, a.baseURL)
	res.Body.Close()
	require.Equal(t, http.StatusFound, res.StatusCode)
	require.Equal(t, "/bookmarks", res.Header.Get("Location"))

	res, err := client.Get(a.url("/bookmarks"))
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body(t, res), "Learning Go")

	res, err = client.Get(a.url("/bookmarks?q=learning"))
	require.NoError(t, err)
	require.Contains(t, body(t, res), "<mark>")

	res = post(t, a, client, "/deletebookmark", url.Values{"url": {"https://example.org/go"}}, a.baseURL)
	res.Body.Close()
	require.Equal(t, http.StatusFound, res.StatusCode)
	require.Equal(t, "/bookmarks", res.Header.Get("Location"))

	res, err = client.Get(a.url("/bookmarks"))
	require.NoError(t, err)
	require.NotContains(t, body(t, res), "Learning Go")
}

func TestAnExistingBookmarkOpensForEditing(t *testing.T) {
	a := startApp(t)
	client := newClient(t)
	body(t, login(t, a, client, "/bookmarks"))
	res := post(t, a, client, "/bookmarks", url.Values{
		"url":   {"https://example.org/kept"},
		"title": {"Kept title"},
		"tags":  {"kept-tag"},
	}, a.baseURL)
	res.Body.Close()

	res, err := client.Get(a.url("/addbookmark?url=https%3A%2F%2Fexample.org%2Fkept&title=Other"))
	require.NoError(t, err)
	page := body(t, res)
	require.Contains(t, page, "Kept title")
	require.Contains(t, page, "kept-tag")
}

func TestACrossOriginFormPostIsRejected(t *testing.T) {
	a := startApp(t)
	client := newClient(t)
	body(t, login(t, a, client, "/bookmarks"))

	res := post(t, a, client, "/bookmarks", url.Values{"url": {"https://example.org/evil"}}, "https://evil.example")
	res.Body.Close()
	require.Equal(t, http.StatusForbidden, res.StatusCode)

	res, err := client.Get(a.url("/bookmarks"))
	require.NoError(t, err)
	require.NotContains(t, body(t, res), "example.org/evil")
}

func TestAnUnchangedBookmarksPageIsNotSentAgain(t *testing.T) {
	a := startApp(t)
	client := newClient(t)
	res := login(t, a, client, "/bookmarks")
	body(t, res)
	lastModified := res.Header.Get("Last-Modified")
	require.NotEmpty(t, lastModified)
	require.Equal(t, "no-cache", res.Header.Get("Cache-Control"))

	req, err := http.NewRequest(http.MethodGet, a.url("/bookmarks"), nil)
	require.NoError(t, err)
	req.Header.Set("If-Modified-Since", lastModified)
	res, err = client.Do(req)
	require.NoError(t, err)
	res.Body.Close()
	require.Equal(t, http.StatusNotModified, res.StatusCode)
}

var feedLink = regexp.MustCompile(`/feeds/([0-9a-zA-Z-]+)`)

func TestTheReadLaterFeedNeedsNoLogin(t *testing.T) {
	a := startApp(t)
	client := newClient(t)
	page := body(t, login(t, a, client, "/bookmarks"))
	match := feedLink.FindStringSubmatch(page)
	require.NotNil(t, match, "the bookmarks page links its feed")

	anonymous := newClient(t)
	res, err := anonymous.Get(a.url("/feeds/" + match[1]))
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Equal(t, "application/rss+xml", res.Header.Get("Content-Type"))
	require.Contains(t, body(t, res), "<rss")

	res, err = anonymous.Get(a.url("/feeds/no-such-feed"))
	require.NoError(t, err)
	res.Body.Close()
	require.Equal(t, http.StatusNotFound, res.StatusCode)
}

func TestTheRootAndTheLogo(t *testing.T) {
	a := startApp(t)
	client := newClient(t)
	body(t, login(t, a, client, "/bookmarks"))

	res, err := client.Get(a.url("/"))
	require.NoError(t, err)
	res.Body.Close()
	require.Equal(t, http.StatusFound, res.StatusCode)
	require.Equal(t, "/bookmarks", res.Header.Get("Location"))

	res, err = client.Get(a.url("/images/delicious.png"))
	require.NoError(t, err)
	res.Body.Close()
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Equal(t, "image/png", res.Header.Get("Content-Type"))
}

func TestPagesAreCompressed(t *testing.T) {
	a := startApp(t)
	client := newClient(t)
	body(t, login(t, a, client, "/bookmarks"))

	req, err := http.NewRequest(http.MethodGet, a.url("/bookmarks"), nil)
	require.NoError(t, err)
	// Asking for gzip explicitly keeps the client from unpacking it.
	req.Header.Set("Accept-Encoding", "gzip")
	res, err := client.Do(req)
	require.NoError(t, err)
	res.Body.Close()
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Equal(t, "gzip", res.Header.Get("Content-Encoding"))
}
