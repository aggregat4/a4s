//go:build e2e
// +build e2e

package server

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"aggregat4/go-commentservice/internal/domain"
	"aggregat4/go-commentservice/internal/repository"
	"aggregat4/go-commentservice/internal/testing/oidcmock"

	"github.com/aggregat4/go-baselib/crypto"
	"github.com/chromedp/chromedp"
)

// findFreePort returns an available TCP port on localhost.
func findFreePort(t testing.TB) int {
	t.Helper()
	l, err := net.Listen("tcp", "localhost:0")
	if err != nil {
		t.Fatalf("failed to find free port: %v", err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	return port
}

// startRealServer starts a real HTTP server on the given port.
func startRealServer(t testing.TB, controller *Controller, port int) *http.Server {
	t.Helper()

	server := InitServer(controller)
	listener, err := net.Listen("tcp", fmt.Sprintf("localhost:%d", port))
	if err != nil {
		t.Fatalf("failed to listen on port %d: %v", port, err)
	}

	go func() {
		if err := server.Serve(listener); err != nil && !strings.Contains(err.Error(), "Server closed") {
			t.Logf("server error: %v", err)
		}
	}()

	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
	})

	return server
}

// newChromeContext returns a chromedp context configured for the environment.
func newChromeContext(t testing.TB) (context.Context, context.CancelFunc) {
	t.Helper()

	chromePath := os.Getenv("CHROME_PATH")
	if chromePath == "" {
		chromePath = "/usr/bin/chromium"
	}

	opts := append(chromedp.DefaultExecAllocatorOptions[:],
		chromedp.ExecPath(chromePath),
		chromedp.NoSandbox,
		chromedp.DisableGPU,
		chromedp.Headless,
	)

	allocCtx, cancelAlloc := chromedp.NewExecAllocator(context.Background(), opts...)
	t.Cleanup(cancelAlloc)

	ctx, cancel := chromedp.NewContext(allocCtx)
	t.Cleanup(cancel)

	return ctx, cancel
}

type e2eServer struct {
	Port    int
	BaseURL string
	Store   *repository.Store
	IDP     *oidcmock.Server
}

func newE2EServer(t testing.TB, serviceKey, serviceOrigin string, roles []string) *e2eServer {
	t.Helper()

	port := findFreePort(t)
	return newE2EServerOnPort(t, port, serviceKey, serviceOrigin, roles)
}

func newE2EServerOnPort(t testing.TB, port int, serviceKey, serviceOrigin string, roles []string) *e2eServer {
	t.Helper()

	redirectURI := fmt.Sprintf("http://localhost:%d/oidccallback", port)
	idp, err := oidcmock.Run(
		"commentservice-client",
		"commentservice-secret",
		redirectURI,
		map[string]any{"roles": roles},
		"",
	)
	if err != nil {
		t.Fatalf("failed to start mock OIDC: %v", err)
	}
	t.Cleanup(idp.Close)

	store := newE2EStore(t)
	if _, err := store.CreateService(serviceKey, serviceOrigin); err != nil {
		t.Fatalf("failed to seed service: %v", err)
	}

	baseURL := fmt.Sprintf("http://localhost:%d", port)
	controller := &Controller{
		Store:  store,
		Config: defaultE2EConfig(port, baseURL, redirectURI, idp.Issuer()),
	}
	_ = startRealServer(t, controller, port)

	return &e2eServer{
		Port:    port,
		BaseURL: baseURL,
		Store:   store,
		IDP:     idp,
	}
}

func newE2EStore(t testing.TB) *repository.Store {
	t.Helper()

	cipher, err := crypto.CreateAes256GcmAead([]byte(testEncryptionKey))
	if err != nil {
		t.Fatalf("failed to create cipher: %v", err)
	}

	store := &repository.Store{Cipher: cipher}
	if err := store.InitAndVerifyDb(repository.CreateInMemoryDbUrl()); err != nil {
		t.Fatalf("failed to init db: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Fatalf("failed to close store: %v", err)
		}
	})
	return store
}

func defaultE2EConfig(port int, baseURL, redirectURI, oidcIssuer string) domain.Config {
	return domain.Config{
		Port:                        port,
		DatabaseFilename:            "",
		BaseURL:                     baseURL,
		ServerReadTimeoutSeconds:    5,
		ServerWriteTimeoutSeconds:   10,
		OidcIdpServer:               oidcIssuer,
		OidcClientId:                "commentservice-client",
		OidcClientSecret:            "commentservice-secret",
		OidcRedirectUri:             redirectURI,
		EncryptionKey:               testEncryptionKey,
		SessionCookieSecretKey:      testSessionCookieSecret,
		SessionCookieSecureFlag:     false,
		SessionCookieCookieMaxAge:   2592000,
		SessionCookieCookieSameSite: "lax",
	}
}

// TestE2E_OidcLoginPersistsSession tests that a user can log in through the OIDC
// flow and the session survives page reloads.
func TestE2E_OidcLoginPersistsSession(t *testing.T) {
	server := newE2EServer(t, testServiceKey, testServiceOrigin, []string{"admin-TESTSERVICE", "superadmin"})

	ctx, cancel := newChromeContext(t)
	defer cancel()

	commentFormURL := server.BaseURL + "/services/" + testServiceKey + "/posts/" + testPostKeyApproved + "/commentform"

	var body string
	var err error

	// Step 1: Navigate to the comment form. Should show login button.
	err = chromedp.Run(ctx,
		chromedp.Navigate(commentFormURL),
		chromedp.WaitVisible(`[data-auth-required]`, chromedp.ByQuery),
		chromedp.OuterHTML("body", &body),
	)
	if err != nil {
		t.Fatalf("step 1 failed: %v", err)
	}
	if !strings.Contains(body, "Login to Comment") {
		t.Fatalf("expected login button on comment form, got: %s", body)
	}
	t.Log("Step 1 passed: comment form shows login button")

	// Step 2: Navigate directly to /login to trigger OIDC flow.
	// The OIDC middleware redirects to the mock IdP, which immediately
	// redirects back to the callback, which creates a session and redirects
	// back to /login.
	err = chromedp.Run(ctx,
		chromedp.Navigate(server.BaseURL+"/login"),
		chromedp.WaitVisible(`[data-auth-success]`, chromedp.ByQuery),
		chromedp.OuterHTML("body", &body),
	)
	if err != nil {
		t.Fatalf("step 2 failed: %v", err)
	}
	if !strings.Contains(body, "Authenticated") {
		t.Fatalf("expected 'Authenticated' after OIDC flow, got: %s", body)
	}
	t.Log("Step 2 passed: OIDC login succeeded")

	// Step 3: Navigate back to the comment form. Should now show the form.
	err = chromedp.Run(ctx,
		chromedp.Navigate(commentFormURL),
		chromedp.WaitVisible(`form[action*="/comments/"]`, chromedp.ByQuery),
		chromedp.OuterHTML("body", &body),
	)
	if err != nil {
		t.Fatalf("step 3 failed: %v", err)
	}
	if strings.Contains(body, "Login to Comment") {
		t.Fatalf("expected comment form after login, but still seeing login button. Body: %s", body)
	}
	if !strings.Contains(body, "Submit") {
		t.Fatalf("expected comment form with Submit button, got: %s", body)
	}
	t.Log("Step 3 passed: comment form visible after login")

	// Step 4: Reload the comment form. Session should persist.
	err = chromedp.Run(ctx,
		chromedp.Reload(),
		chromedp.WaitVisible(`form[action*="/comments/"]`, chromedp.ByQuery),
		chromedp.OuterHTML("body", &body),
	)
	if err != nil {
		t.Fatalf("step 4 failed: %v", err)
	}
	if strings.Contains(body, "Login to Comment") {
		t.Fatalf("session did not persist after reload. Body: %s", body)
	}
	if !strings.Contains(body, "Submit") {
		t.Fatalf("expected comment form after reload, got: %s", body)
	}
	t.Log("Step 4 passed: session persists after reload")
}

// TestE2E_CommentSubmissionAndModerationFlow verifies the primary browser
// workflow: a user submits comments, an admin approves one, and an admin deletes
// another through the dashboard UI.
func TestE2E_CommentSubmissionAndModerationFlow(t *testing.T) {
	server := newE2EServer(t, testServiceKey, testServiceOrigin, []string{"admin-TESTSERVICE", "superadmin"})

	ctx, cancel := newChromeContext(t)
	defer cancel()

	postKey := "e2e-moderation-post"
	commentFormURL := server.BaseURL + "/services/" + testServiceKey + "/posts/" + postKey + "/commentform"
	postCommentsURL := server.BaseURL + "/services/" + testServiceKey + "/posts/" + postKey + "/comments/"
	adminCommentsURL := server.BaseURL + "/admin/" + testServiceKey + "/comments"

	if err := chromedp.Run(ctx,
		chromedp.Navigate(server.BaseURL+"/login"),
		chromedp.WaitVisible(`[data-auth-success]`, chromedp.ByQuery),
	); err != nil {
		t.Fatalf("login failed: %v", err)
	}

	submitComment := func(comment string) {
		t.Helper()
		if err := chromedp.Run(ctx,
			chromedp.Navigate(commentFormURL),
			chromedp.WaitVisible(`form[action*="/comments/"]`, chromedp.ByQuery),
			chromedp.SetValue(`#name`, "Browser User", chromedp.ByQuery),
			chromedp.SetValue(`#website`, "https://reader.example.com", chromedp.ByQuery),
			chromedp.SetValue(`#comment`, comment, chromedp.ByQuery),
			chromedp.Click(`input[type="submit"]`, chromedp.ByQuery),
			chromedp.WaitVisible(`.toast.success`, chromedp.ByQuery),
		); err != nil {
			t.Fatalf("failed to submit comment %q: %v", comment, err)
		}
	}

	approveComment := func(commentID int) {
		t.Helper()
		actionURL := fmt.Sprintf("/admin/%s/comments/%d/approve", testServiceKey, commentID)
		if err := chromedp.Run(ctx,
			chromedp.Navigate(adminCommentsURL),
			chromedp.WaitVisible(`action-confirmation[actionurl="`+actionURL+`"]`, chromedp.ByQuery),
			chromedp.Evaluate(fmt.Sprintf(`
				(() => {
					const action = document.querySelector('action-confirmation[actionurl=%q]');
					action.shadowRoot.querySelector('.confirm').click();
					action.shadowRoot.querySelector('.action').click();
				})()
			`, actionURL), nil),
			chromedp.WaitVisible(`.badge.approved`, chromedp.ByQuery),
		); err != nil {
			t.Fatalf("failed to approve comment %d: %v", commentID, err)
		}
	}

	deleteComment := func(commentID int) {
		t.Helper()
		actionURL := fmt.Sprintf("/admin/%s/comments/%d/delete", testServiceKey, commentID)
		actionSelector := `action-confirmation[actionurl="` + actionURL + `"]`
		if err := chromedp.Run(ctx,
			chromedp.Navigate(adminCommentsURL),
			chromedp.WaitVisible(actionSelector, chromedp.ByQuery),
			chromedp.Evaluate(fmt.Sprintf(`
				(() => {
					const action = document.querySelector('action-confirmation[actionurl=%q]');
					action.shadowRoot.querySelector('.confirm').click();
					action.shadowRoot.querySelector('.action').click();
				})()
			`, actionURL), nil),
			chromedp.WaitNotPresent(actionSelector, chromedp.ByQuery),
		); err != nil {
			t.Fatalf("failed to delete comment %d: %v", commentID, err)
		}
	}

	const approvedCommentBody = "This comment should be approved from the browser."
	submitComment(approvedCommentBody)

	approvedCandidate := findCommentByBody(t, server.Store, approvedCommentBody)
	if approvedCandidate.Status != domain.CommentStatusPendingApproval {
		t.Fatalf("expected new comment to start pending approval, got %v", approvedCandidate.Status)
	}

	var body string
	if err := chromedp.Run(ctx,
		chromedp.Navigate(postCommentsURL),
		chromedp.WaitVisible(`.badge.pending-approval`, chromedp.ByQuery),
		chromedp.OuterHTML("body", &body),
	); err != nil {
		t.Fatalf("failed to inspect pending comment page: %v", err)
	}
	if !strings.Contains(body, approvedCommentBody) || !strings.Contains(body, "Awaiting moderation") {
		t.Fatalf("expected own pending comment to be visible with moderation status, got: %s", body)
	}

	approveComment(approvedCandidate.Id)

	approvedCandidate = mustGetComment(t, server.Store, approvedCandidate.Id)
	if approvedCandidate.Status != domain.CommentStatusApproved {
		t.Fatalf("expected approved comment after admin action, got %v", approvedCandidate.Status)
	}

	if err := chromedp.Run(ctx,
		chromedp.Navigate(postCommentsURL),
		chromedp.WaitVisible(`dl.comments`, chromedp.ByQuery),
		chromedp.OuterHTML("body", &body),
	); err != nil {
		t.Fatalf("failed to inspect approved comment page: %v", err)
	}
	if !strings.Contains(body, approvedCommentBody) || strings.Contains(body, "Awaiting moderation") {
		t.Fatalf("expected approved comment without pending badge, got: %s", body)
	}

	const deletedCommentBody = "This comment should be deleted from the browser."
	submitComment(deletedCommentBody)
	deletedCandidate := findCommentByBody(t, server.Store, deletedCommentBody)

	deleteComment(deletedCandidate.Id)

	if _, err := server.Store.GetComment(deletedCandidate.Id); err == nil {
		t.Fatalf("expected deleted comment %d to be removed", deletedCandidate.Id)
	}

	if err := chromedp.Run(ctx,
		chromedp.Navigate(adminCommentsURL),
		chromedp.WaitVisible(`dl.comments`, chromedp.ByQuery),
		chromedp.OuterHTML("body", &body),
	); err != nil {
		t.Fatalf("failed to inspect admin dashboard after delete: %v", err)
	}
	if strings.Contains(body, deletedCommentBody) {
		t.Fatalf("expected deleted comment to be absent from dashboard, got: %s", body)
	}
}

func findCommentByBody(t testing.TB, store *repository.Store, body string) domain.Comment {
	t.Helper()

	comments, err := store.GetCommentsByStatus(nil)
	if err != nil {
		t.Fatalf("failed to load comments: %v", err)
	}
	for _, comment := range comments {
		if comment.Comment == body {
			return comment
		}
	}

	t.Fatalf("expected comment %q to exist", body)
	return domain.Comment{}
}

func mustGetComment(t testing.TB, store *repository.Store, commentID int) domain.Comment {
	t.Helper()

	comment, err := store.GetComment(commentID)
	if err != nil {
		t.Fatalf("failed to load comment %d: %v", commentID, err)
	}
	return comment
}

// TestE2E_IframeLayoutLoginUsesTopLevelHandoff tests that clicking the "Log in to
// the Comment Service" link inside an embedded iframe asks the parent page to
// start a top-level auth flow, then returns to the embedder with a persistent
// authenticated session.
func TestE2E_IframeLayoutLoginUsesTopLevelHandoff(t *testing.T) {
	port := findFreePort(t)
	server := newE2EServerOnPort(t, port, "demoservice", "http://localhost:"+strconv.Itoa(port), []string{"admin-demoservice", "superadmin"})

	ctx, cancel := newChromeContext(t)
	defer cancel()

	var iframeHTML string

	// Step 1: Navigate to the demo page. The iframe should show the login link.
	err := chromedp.Run(ctx,
		chromedp.Navigate(server.BaseURL+"/demo"),
		chromedp.WaitVisible("iframe", chromedp.ByQuery),
		chromedp.PollFunction(`() => {
			try {
				const iframe = document.querySelector('iframe');
				return iframe.contentDocument.body.innerHTML;
			} catch (e) {
				return '';
			}
		}`, &iframeHTML, chromedp.WithPollingInterval(100*time.Millisecond), chromedp.WithPollingTimeout(5*time.Second)),
	)
	if err != nil {
		t.Fatalf("step 1 failed: %v", err)
	}
	if !strings.Contains(iframeHTML, "Log in to the Comment Service") {
		t.Fatalf("expected login link in iframe, got: %s", iframeHTML)
	}
	t.Log("Step 1 passed: iframe shows login link")

	// Step 2: Click the login link inside the iframe. The iframe asks the parent
	// page to navigate the top-level window through the login handoff.
	err = chromedp.Run(ctx,
		chromedp.Evaluate(`document.querySelector('iframe').contentDocument.querySelector('a[data-embed-login-path]').click()`, nil),
	)
	if err != nil {
		t.Fatalf("step 2 click failed: %v", err)
	}
	t.Log("Step 2: clicked iframe login link")

	// Step 3: Wait for the top-level page to return to /demo, then verify that
	// the embedded iframe shows the authenticated state.
	err = chromedp.Run(ctx,
		chromedp.WaitVisible("iframe", chromedp.ByQuery),
		chromedp.PollFunction(`() => {
			try {
				const iframe = document.querySelector('iframe');
				const doc = iframe.contentDocument;
				if (!doc || !doc.body) {
					return '';
				}
				const html = doc.body.innerHTML;
				// Keep polling while we still see the unauthenticated login link.
				if (html.includes('Log in to the Comment Service')) {
					return '';
				}
				return html;
			} catch (e) {
				return '';
			}
		}`, &iframeHTML, chromedp.WithPollingInterval(100*time.Millisecond), chromedp.WithPollingTimeout(10*time.Second)),
	)
	if err != nil {
		t.Fatalf("step 3 failed: %v", err)
	}
	if strings.Contains(iframeHTML, "Log in to the Comment Service") {
		t.Fatalf("expected authenticated state after iframe login, but still seeing login link. Body: %s", iframeHTML)
	}
	if !strings.Contains(iframeHTML, "Log out") {
		t.Fatalf("expected logout button after iframe login, got: %s", iframeHTML)
	}
	t.Log("Step 3 passed: iframe shows authenticated state after top-level login handoff")

	// Step 4: Reload the parent page. The iframe should still be authenticated.
	err = chromedp.Run(ctx,
		chromedp.Reload(),
		chromedp.WaitVisible("iframe", chromedp.ByQuery),
		chromedp.PollFunction(`() => {
			try {
				const iframe = document.querySelector('iframe');
				return iframe.contentDocument.body.innerHTML;
			} catch (e) {
				return '';
			}
		}`, &iframeHTML, chromedp.WithPollingInterval(100*time.Millisecond), chromedp.WithPollingTimeout(2*time.Second)),
	)
	if err != nil {
		t.Fatalf("step 4 failed: %v", err)
	}
	if strings.Contains(iframeHTML, "Log in to the Comment Service") {
		t.Fatalf("session did not persist after parent reload. Iframe body: %s", iframeHTML)
	}
	if !strings.Contains(iframeHTML, "Log out") {
		t.Fatalf("expected logout button in iframe after reload, got: %s", iframeHTML)
	}
	t.Log("Step 4 passed: session persists after parent reload")

	// Step 5: Submit a comment from inside the embedded UI and verify that the
	// iframe returns to the post page showing the author's pending comment.
	const embeddedCommentBody = "This comment was submitted from inside the iframe."
	err = chromedp.Run(ctx,
		chromedp.Evaluate(`
			document.querySelector('iframe')
				.contentDocument
				.querySelector('a[href*="/commentform"]')
				.click()
		`, nil),
		chromedp.PollFunction(`() => {
			const doc = document.querySelector('iframe')?.contentDocument;
			return Boolean(doc?.querySelector('form[action*="/comments/"]'));
		}`, nil, chromedp.WithPollingInterval(100*time.Millisecond), chromedp.WithPollingTimeout(5*time.Second)),
		chromedp.Evaluate(fmt.Sprintf(`
			(() => {
				const doc = document.querySelector('iframe').contentDocument;
				doc.querySelector('#name').value = 'Embedded Browser User';
				doc.querySelector('#website').value = 'https://reader.example.com';
				doc.querySelector('#comment').value = %q;
				doc.querySelector('input[type="submit"]').click();
			})()
		`, embeddedCommentBody), nil),
		chromedp.PollFunction(`() => {
			const doc = document.querySelector('iframe')?.contentDocument;
			const body = doc?.body?.innerHTML ?? '';
			return body.includes('This comment was submitted from inside the iframe.') &&
				body.includes('Awaiting moderation')
				? body
				: '';
		}`, &iframeHTML, chromedp.WithPollingInterval(100*time.Millisecond), chromedp.WithPollingTimeout(5*time.Second)),
	)
	if err != nil {
		t.Fatalf("step 5 failed: %v", err)
	}
	embeddedComment := findCommentByBody(t, server.Store, embeddedCommentBody)
	if embeddedComment.ServiceKey != "demoservice" || embeddedComment.PostKey != "demopost" {
		t.Fatalf("expected embedded comment to target demoservice/demopost, got %s/%s", embeddedComment.ServiceKey, embeddedComment.PostKey)
	}
	if embeddedComment.Status != domain.CommentStatusPendingApproval {
		t.Fatalf("expected embedded comment to start pending approval, got %v", embeddedComment.Status)
	}
	t.Log("Step 5 passed: iframe comment submission creates a pending comment")
}

// TestE2E_CrossOriginEmbedReportsAuthStateAfterTopLevelLogin verifies the
// embedder-facing contract across an actual origin boundary. The host page never
// reaches into the iframe DOM; it observes the documented postMessage events and
// initiates the documented top-level handoff itself.
func TestE2E_CrossOriginEmbedReportsAuthStateAfterTopLevelLogin(t *testing.T) {
	commentPort := findFreePort(t)
	commentBaseURL := fmt.Sprintf("http://localhost:%d", commentPort)
	var embedderURL string
	embedder := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = fmt.Fprintf(w, `<!doctype html>
<html>
<body data-authenticated="">
  <iframe class="comment-frame" src="%s/services/crossorigin/posts/post-1/comments/"></iframe>
  <button id="login" type="button">Log in</button>
  <script>
    const commentServiceOrigin = %q;
    const loginPath = '/login/services/crossorigin/embed';
    window.addEventListener('message', (event) => {
      if (event.origin !== commentServiceOrigin) return;
      if (event.data?.type === 'comment-auth-state') {
        document.body.dataset.authenticated = String(event.data.authenticated);
      }
    });
    document.getElementById('login').addEventListener('click', () => {
      const loginUrl = new URL(loginPath, commentServiceOrigin);
      loginUrl.searchParams.set('returnTo', window.location.href);
      window.location.href = loginUrl.toString();
    });
  </script>
</body>
</html>`, commentBaseURL, commentBaseURL)
	}))
	embedderListener, err := net.Listen("tcp", "localhost:0")
	if err != nil {
		t.Fatalf("failed to start embedder listener: %v", err)
	}
	embedder.Listener = embedderListener
	embedder.Start()
	defer embedder.Close()
	embedderURL = strings.Replace(embedder.URL, "127.0.0.1", "localhost", 1)

	_ = newE2EServerOnPort(t, commentPort, "crossorigin", embedderURL, []string{"admin-crossorigin", "superadmin"})

	ctx, cancel := newChromeContext(t)
	defer cancel()

	var authState string
	err = chromedp.Run(ctx,
		chromedp.Navigate(embedderURL),
		chromedp.WaitVisible("iframe", chromedp.ByQuery),
		chromedp.PollFunction(`() => document.body.dataset.authenticated`, &authState,
			chromedp.WithPollingInterval(100*time.Millisecond),
			chromedp.WithPollingTimeout(5*time.Second)),
	)
	if err != nil {
		t.Fatalf("initial embed load failed: %v", err)
	}
	if authState != "false" {
		t.Fatalf("expected initial unauthenticated iframe state, got %q", authState)
	}

	err = chromedp.Run(ctx,
		chromedp.Click("#login", chromedp.ByQuery),
		chromedp.WaitVisible("iframe", chromedp.ByQuery),
		chromedp.PollFunction(`() => document.body.dataset.authenticated === 'true'`, nil,
			chromedp.WithPollingInterval(100*time.Millisecond),
			chromedp.WithPollingTimeout(10*time.Second)),
	)
	if err != nil {
		t.Fatalf("top-level embed login flow failed: %v", err)
	}
}
