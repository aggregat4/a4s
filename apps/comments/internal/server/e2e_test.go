package server

import (
	"context"
	"fmt"
	"net"
	"net/http"
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

	opts := append(chromedp.DefaultExecAllocatorOptions[:],
		chromedp.ExecPath("/usr/bin/chromium"),
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

// TestE2E_OidcLoginPersistsSession tests that a user can log in through the OIDC
// flow and the session survives page reloads.
func TestE2E_OidcLoginPersistsSession(t *testing.T) {
	port := findFreePort(t)
	redirectURI := fmt.Sprintf("http://localhost:%d/oidccallback", port)

	idp, err := oidcmock.Run(
		"commentservice-client",
		"commentservice-secret",
		redirectURI,
		map[string]any{
			"roles": []string{"admin-TESTSERVICE", "superadmin"},
		},
		"",
	)
	if err != nil {
		t.Fatalf("failed to start mock OIDC: %v", err)
	}
	defer idp.Close()

	cipher, err := crypto.CreateAes256GcmAead([]byte(testEncryptionKey))
	if err != nil {
		t.Fatalf("failed to create cipher: %v", err)
	}

	store := &repository.Store{Cipher: cipher}
	if err := store.InitAndVerifyDb(repository.CreateInMemoryDbUrl()); err != nil {
		t.Fatalf("failed to init db: %v", err)
	}
	defer store.Close()

	if _, err := store.CreateService(testServiceKey, testServiceOrigin); err != nil {
		t.Fatalf("failed to seed service: %v", err)
	}

	baseURL := fmt.Sprintf("http://localhost:%d", port)
	controller := &Controller{
		Store: store,
		Config: domain.Config{
			Port:                        port,
			DatabaseFilename:            "",
			BaseURL:                     baseURL,
			ServerReadTimeoutSeconds:    5,
			ServerWriteTimeoutSeconds:   10,
			OidcIdpServer:               idp.Issuer(),
			OidcClientId:                "commentservice-client",
			OidcClientSecret:            "commentservice-secret",
			OidcRedirectUri:             redirectURI,
			EncryptionKey:               testEncryptionKey,
			SessionCookieSecretKey:      testSessionCookieSecret,
			SessionCookieSecureFlag:     false,
			SessionCookieCookieMaxAge:   2592000,
			SessionCookieCookieSameSite: "lax",
		},
	}

	_ = startRealServer(t, controller, port)

	ctx, cancel := newChromeContext(t)
	defer cancel()

	commentFormURL := baseURL + "/services/" + testServiceKey + "/posts/" + testPostKeyApproved + "/commentform"

	var body string

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
		chromedp.Navigate(baseURL+"/login"),
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

// TestE2E_IframeLayoutLoginUsesTopLevelHandoff tests that clicking the "Log in to
// the Comment Service" link inside an embedded iframe asks the parent page to
// start a top-level auth flow, then returns to the embedder with a persistent
// authenticated session.
func TestE2E_IframeLayoutLoginUsesTopLevelHandoff(t *testing.T) {
	port := findFreePort(t)
	redirectURI := fmt.Sprintf("http://localhost:%d/oidccallback", port)

	idp, err := oidcmock.Run(
		"commentservice-client",
		"commentservice-secret",
		redirectURI,
		map[string]any{
			"roles": []string{"admin-demoservice", "superadmin"},
		},
		"",
	)
	if err != nil {
		t.Fatalf("failed to start mock OIDC: %v", err)
	}
	defer idp.Close()

	cipher, err := crypto.CreateAes256GcmAead([]byte(testEncryptionKey))
	if err != nil {
		t.Fatalf("failed to create cipher: %v", err)
	}

	store := &repository.Store{Cipher: cipher}
	if err := store.InitAndVerifyDb(repository.CreateInMemoryDbUrl()); err != nil {
		t.Fatalf("failed to init db: %v", err)
	}
	defer store.Close()

	if _, err := store.CreateService("demoservice", "http://localhost:"+strconv.Itoa(port)); err != nil {
		t.Fatalf("failed to seed service: %v", err)
	}

	baseURL := fmt.Sprintf("http://localhost:%d", port)
	controller := &Controller{
		Store: store,
		Config: domain.Config{
			Port:                        port,
			DatabaseFilename:            "",
			BaseURL:                     baseURL,
			ServerReadTimeoutSeconds:    5,
			ServerWriteTimeoutSeconds:   10,
			OidcIdpServer:               idp.Issuer(),
			OidcClientId:                "commentservice-client",
			OidcClientSecret:            "commentservice-secret",
			OidcRedirectUri:             redirectURI,
			EncryptionKey:               testEncryptionKey,
			SessionCookieSecretKey:      testSessionCookieSecret,
			SessionCookieSecureFlag:     false,
			SessionCookieCookieMaxAge:   2592000,
			SessionCookieCookieSameSite: "lax",
		},
	}

	_ = startRealServer(t, controller, port)

	ctx, cancel := newChromeContext(t)
	defer cancel()

	var iframeHTML string

	// Step 1: Navigate to the demo page. The iframe should show the login link.
	err = chromedp.Run(ctx,
		chromedp.Navigate(baseURL+"/demo"),
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
}
