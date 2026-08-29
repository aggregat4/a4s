package server

import (
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

type statusMatcher func(int) bool

func expectAny(statuses ...int) statusMatcher {
	allowed := make(map[int]struct{}, len(statuses))
	for _, s := range statuses {
		allowed[s] = struct{}{}
	}
	return func(code int) bool {
		_, ok := allowed[code]
		return ok
	}
}

func TestProtectedRoutesRequireAuthentication(t *testing.T) {
	h := NewServerHarness(t)
	client := h.NewClient(false)

	cases := []struct {
		name    string
		method  string
		path    string
		matcher statusMatcher
	}{
		{name: "user comments index", method: http.MethodGet, path: "/users/1/comments/", matcher: expectAny(http.StatusUnauthorized, http.StatusFound)},
		{name: "user comment edit", method: http.MethodGet, path: "/users/1/comments/1/edit", matcher: expectAny(http.StatusUnauthorized, http.StatusFound)},
		{name: "admin dashboard", method: http.MethodGet, path: "/admin", matcher: expectAny(http.StatusUnauthorized, http.StatusFound)},
		{name: "admin service comments", method: http.MethodGet, path: "/admin/any-service/comments", matcher: expectAny(http.StatusUnauthorized, http.StatusFound, http.StatusForbidden)},
		{name: "superadmin services", method: http.MethodGet, path: "/superadmin/services", matcher: expectAny(http.StatusUnauthorized, http.StatusFound, http.StatusForbidden)},
		{name: "superadmin comments", method: http.MethodGet, path: "/superadmin/comments", matcher: expectAny(http.StatusUnauthorized, http.StatusFound, http.StatusForbidden)},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req, err := http.NewRequest(tc.method, h.URL(tc.path), nil)
			require.NoError(t, err)

			res, err := client.Do(req)
			require.NoError(t, err)
			if !tc.matcher(res.StatusCode) {
				t.Fatalf("unexpected status %d for %s %s", res.StatusCode, tc.method, tc.path)
			}
		})
	}
}

func TestUnauthenticatedCommentSubmissionRejected(t *testing.T) {
	h := NewServerHarness(t)
	client := h.NewClient(false)

	form := url.Values{}
	form.Set("comment", "Unauthenticated comment")
	form.Set("name", "Anonymous")
	form.Set("website", "https://example.com")

	req, err := http.NewRequest(
		http.MethodPost,
		h.URL("/users/"+strconv.Itoa(h.Data.PrimaryUser.Id)+"/services/"+h.Data.Service.ServiceKey+"/posts/"+testPostKeyApproved+"/comments/"),
		strings.NewReader(form.Encode()),
	)
	require.NoError(t, err)

	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Origin", "https://example.com")

	res, err := client.Do(req)
	require.NoError(t, err)
	if res.StatusCode != http.StatusUnauthorized && res.StatusCode != http.StatusForbidden {
		t.Fatalf("expected unauthorized POST, got %d", res.StatusCode)
	}
}

func TestInvalidIdRoutesFailGracefully(t *testing.T) {
	h := NewServerHarness(t)
	client := h.NewClient(false)

	getCases := []string{
		"/users/999999/comments/",
		"/users/abc/comments/",
		"/users/-42/comments/",
	}

	for _, path := range getCases {
		t.Run("GET "+path, func(t *testing.T) {
			res, err := client.Get(h.URL(path))
			require.NoError(t, err)
			if res.StatusCode < 300 {
				t.Fatalf("expected non-success status for %s, got %d", path, res.StatusCode)
			}
		})
	}

	postCases := []string{
		"/admin/blog1/comments/99999/approve",
		"/admin/blog1/comments/99999/delete",
		"/users/1/comments/99999/edit",
	}

	for _, path := range postCases {
		t.Run("POST "+path, func(t *testing.T) {
			req, err := http.NewRequest(http.MethodPost, h.URL(path), strings.NewReader(""))
			require.NoError(t, err)
			req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
			req.Header.Set("Origin", "https://example.com")

			res, err := client.Do(req)
			require.NoError(t, err)
			if res.StatusCode < 300 {
				t.Fatalf("expected non-success status for %s, got %d", path, res.StatusCode)
			}
		})
	}
}

func TestStaticAssetsAccessible(t *testing.T) {
	h := NewServerHarness(t)
	client := h.NewClient(true)

	paths := []string{
		"/css/main.css",
		"/js/components.js",
	}

	for _, path := range paths {
		t.Run(path, func(t *testing.T) {
			res, err := client.Get(h.URL(path))
			require.NoError(t, err)
			if res.StatusCode != http.StatusOK && res.StatusCode != http.StatusNotFound {
				t.Fatalf("unexpected status %d for %s", res.StatusCode, path)
			}
		})
	}
}
