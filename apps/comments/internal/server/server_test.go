package server

import (
	"testing"

	_ "github.com/mattn/go-sqlite3"
	"github.com/stretchr/testify/assert"
)

func TestStatus(t *testing.T) {
	h := NewServerHarness(t)
	client := h.NewClient(true)
	res, err := client.Get(h.URL("/status"))
	if err != nil {
		t.Fatal(err)
	}
	assert.Equal(t, 200, res.StatusCode)
	assert.Equal(t, "text/plain; charset=utf-8", res.Header.Get("Content-Type"))
	body := readBody(res)
	assert.Equal(t, "OK", body)
}

func TestInvalidService(t *testing.T) {
	h := NewServerHarness(t)
	client := h.NewClient(true)
	res, err := client.Get(h.URL("/services/foo/posts/bar/comments/"))
	if err != nil {
		t.Fatal(err)
	}
	assert.Equal(t, 404, res.StatusCode)
}

func TestEmptyCommentsPage(t *testing.T) {
	h := NewServerHarness(t)
	client := h.NewClient(true)
	res, err := client.Get(h.URL("/services/" + h.Data.Service.ServiceKey + "/posts/bar/comments/"))
	if err != nil {
		t.Fatal(err)
	}
	assert.Equal(t, 200, res.StatusCode)
	assert.Equal(t, "text/html; charset=utf-8", res.Header.Get("Content-Type"))
	body := readBody(res)
	assert.Contains(t, body, "<!DOCTYPE html>")
}

func TestSingleCommentPostPage(t *testing.T) {
	h := NewServerHarness(t)
	client := h.NewClient(true)
	res, err := client.Get(h.URL("/services/" + h.Data.Service.ServiceKey + "/posts/" + testPostKeyApproved + "/comments/"))
	if err != nil {
		t.Fatal(err)
	}
	assert.Equal(t, 200, res.StatusCode)
	body := readBody(res)
	approved := h.Data.Comments["approved"].Comment
	pending := h.Data.Comments["pending"].Comment
	// Only approved comments should be visible on the public page
	assert.Contains(t, body, approved)
	assert.NotContains(t, body, pending)
}

func TestPrivacyPolicyPage(t *testing.T) {
	h := NewServerHarness(t)
	client := h.NewClient(true)
	res, err := client.Get(h.URL("/privacy-policy"))
	if err != nil {
		t.Fatal(err)
	}
	assert.Equal(t, 200, res.StatusCode)
	body := readBody(res)
	assert.Contains(t, body, "<h1>Privacy Policy</h1>")
}

func TestCommentFormUsesPrivacyConfig(t *testing.T) {
	h := NewServerHarness(t)
	h.Controller.Config.PrivacyPolicyURL = "https://example.com/privacy"
	h.Controller.Config.MinimumCommentAge = 16

	client := h.NewClient(true)
	cookie := h.MustUserSessionCookie(h.Data.PrimaryUser.Id)
	h.SetCookie(client, cookie)

	res, err := client.Get(h.URL("/users/1/services/" + h.Data.Service.ServiceKey + "/posts/" + testPostKeyApproved + "/commentform"))
	if err != nil {
		t.Fatal(err)
	}
	body := readBody(res)
	assert.Contains(t, body, "You must be 16 years or older to comment.")
	assert.Contains(t, body, `href="https://example.com/privacy"`)
}
