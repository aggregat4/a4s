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
	rejected := h.Data.Comments["rejected"].Comment

	// Only approved comments should be visible on the public page
	assert.Contains(t, body, approved)
	assert.NotContains(t, body, pending)
	assert.NotContains(t, body, rejected)
}
