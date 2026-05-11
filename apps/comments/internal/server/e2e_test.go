package server

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"aggregat4/go-commentservice/internal/domain"
	"aggregat4/go-commentservice/internal/repository"
	"aggregat4/go-commentservice/internal/testing/oidcmock"

	"github.com/aggregat4/go-baselib/crypto"
	"github.com/chromedp/cdproto/target"
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

// TestE2E_OidcPopupLoginPersistsSession tests the full popup flow: clicking the
// login button opens a popup, the OIDC flow completes in the popup, the popup
// posts auth-success to the parent, and the parent reloads to show the comment
// form with a persistent session.
func TestE2E_OidcPopupLoginPersistsSession(t *testing.T) {
	port := findFreePort(t)
	redirectURI := fmt.Sprintf("http://localhost:%d/oidccallback", port)

	idp, err := oidcmock.Run(
		"commentservice-client",
		"commentservice-secret",
		redirectURI,
		map[string]any{
			"roles": []string{"admin-TESTSERVICE", "superadmin"},
		},
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

	// Step 1: Navigate to comment form and click login button.
	err = chromedp.Run(ctx,
		chromedp.Navigate(commentFormURL),
		chromedp.WaitVisible(`[data-login-button]`, chromedp.ByQuery),
	)
	if err != nil {
		t.Fatalf("step 1 failed: %v", err)
	}

	// Listen for a new target (popup) before clicking.
	popupCtx, cancelPopup := context.WithCancel(ctx)
	defer cancelPopup()

	popupTargetCh := make(chan string, 1)
	chromedp.ListenTarget(ctx, func(ev interface{}) {
		switch ev := ev.(type) {
		case *target.EventTargetCreated:
			if ev.TargetInfo.OpenerID != "" {
				select {
				case popupTargetCh <- string(ev.TargetInfo.TargetID):
				default:
				}
			}
		}
	})

	err = chromedp.Run(ctx,
		chromedp.Click(`[data-login-button]`, chromedp.ByQuery),
	)
	if err != nil {
		t.Fatalf("failed to click login button: %v", err)
	}

	// Wait for popup target to be created.
	var popupTargetID string
	select {
	case popupTargetID = <-popupTargetCh:
		t.Logf("Popup target created: %s", popupTargetID)
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for popup target")
	}

	// Attach to the popup and wait for it to complete auth and close.
	popupCtx, cancelPopup = chromedp.NewContext(ctx, chromedp.WithTargetID(target.ID(popupTargetID)))
	defer cancelPopup()

	// The popup navigates through OIDC and lands on /login?popup=1 showing "Authenticated".
	err = chromedp.Run(popupCtx,
		chromedp.WaitVisible(`[data-auth-success]`, chromedp.ByQuery),
	)
	if err != nil {
		t.Fatalf("popup did not reach auth success: %v", err)
	}
	t.Log("Step 2 passed: popup authenticated")

	// Wait for popup to close itself (it closes after 500ms).
	err = chromedp.Run(popupCtx,
		chromedp.WaitVisible(`html`, chromedp.ByQuery),
	)
	// We expect an error because the popup closes.
	if err == nil {
		// If no error, wait a bit more for the popup to close.
		select {
		case <-time.After(2 * time.Second):
		}
	}

	// Step 3: Parent page should have reloaded and now show the comment form.
	// Switch back to the original target context.
	err = chromedp.Run(ctx,
		chromedp.WaitVisible(`form[action*="/comments/"]`, chromedp.ByQuery),
		chromedp.OuterHTML("body", &body),
	)
	if err != nil {
		t.Fatalf("step 3 failed: %v", err)
	}
	if strings.Contains(body, "Login to Comment") {
		t.Fatalf("expected comment form after popup login, but still seeing login button. Body: %s", body)
	}
	if !strings.Contains(body, "Submit") {
		t.Fatalf("expected comment form with Submit button, got: %s", body)
	}
	t.Log("Step 3 passed: comment form visible after popup login")

	// Step 4: Reload to verify session persistence.
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
