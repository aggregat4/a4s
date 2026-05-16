package server

import (
	"net/http"
	"net/url"
	"strconv"
	"strings"
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

func TestPostPageShowsPendingCommentToItsAuthor(t *testing.T) {
	h := NewServerHarness(t)
	client := h.NewClient(true)
	h.SetCookie(client, h.MustUserSessionCookie(h.Data.PrimaryUser.Id))

	res, err := client.Get(h.URL("/services/" + h.Data.Service.ServiceKey + "/posts/" + testPostKeyApproved + "/comments/"))
	if err != nil {
		t.Fatal(err)
	}

	body := readBody(res)
	assert.Contains(t, body, h.Data.Comments["approved"].Comment)
	assert.Contains(t, body, h.Data.Comments["pending"].Comment)
	assert.Contains(t, body, "Awaiting moderation")
	assert.Equal(t, 4, strings.Count(body, `class="own-comment"`))
	assert.Equal(t, 2, strings.Count(body, "Your comment"))
}

func TestPostPageHidesPendingCommentFromOtherUsers(t *testing.T) {
	h := NewServerHarness(t)
	client := h.NewClient(true)
	h.SetCookie(client, h.MustUserSessionCookie(h.Data.AdditionalUser.Id))

	res, err := client.Get(h.URL("/services/" + h.Data.Service.ServiceKey + "/posts/" + testPostKeyApproved + "/comments/"))
	if err != nil {
		t.Fatal(err)
	}

	body := readBody(res)
	assert.Contains(t, body, h.Data.Comments["approved"].Comment)
	assert.NotContains(t, body, h.Data.Comments["pending"].Comment)
	assert.NotContains(t, body, "Awaiting moderation")
	assert.NotContains(t, body, `class="own-comment"`)
	assert.NotContains(t, body, "Your comment")
}

func TestApprovedCommentEditFormIsForbiddenToAuthor(t *testing.T) {
	h := NewServerHarness(t)
	client := h.NewClient(true)
	h.SetCookie(client, h.MustUserSessionCookie(h.Data.PrimaryUser.Id))

	approved := h.Data.Comments["approved"]
	res, err := client.Get(h.URL("/users/" + strconv.Itoa(h.Data.PrimaryUser.Id) + "/comments/" + strconv.Itoa(approved.Id) + "/edit"))
	if err != nil {
		t.Fatal(err)
	}

	assert.Equal(t, http.StatusForbidden, res.StatusCode)
}

func TestPendingCommentCanBeEditedByAuthor(t *testing.T) {
	h := NewServerHarness(t)
	client := h.NewClient(true)
	h.SetCookie(client, h.MustUserSessionCookie(h.Data.PrimaryUser.Id))

	pending := h.Data.Comments["pending"]
	res, err := client.Get(h.URL("/users/" + strconv.Itoa(h.Data.PrimaryUser.Id) + "/comments/" + strconv.Itoa(pending.Id) + "/edit"))
	if err != nil {
		t.Fatal(err)
	}

	assert.Equal(t, http.StatusOK, res.StatusCode)
	assert.Contains(t, readBody(res), "<h2>Edit Comment</h2>")
}

func TestApprovedCommentCanBeDeletedByAuthor(t *testing.T) {
	h := NewServerHarness(t)
	client := h.NewClient(false)
	h.SetCookie(client, h.MustUserSessionCookie(h.Data.PrimaryUser.Id))

	approved := h.Data.Comments["approved"]
	req, err := http.NewRequest(
		http.MethodPost,
		h.URL("/users/"+strconv.Itoa(h.Data.PrimaryUser.Id)+"/comments/"+strconv.Itoa(approved.Id)+"/delete"),
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}

	res, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}

	assert.Equal(t, http.StatusFound, res.StatusCode)
	_, err = h.Store.GetComment(approved.Id)
	assert.Error(t, err)
}

func TestApprovedCommentUpdateIsForbiddenToAuthor(t *testing.T) {
	h := NewServerHarness(t)
	client := h.NewClient(false)
	h.SetCookie(client, h.MustUserSessionCookie(h.Data.PrimaryUser.Id))

	approved := h.Data.Comments["approved"]
	form := url.Values{}
	form.Set("commentId", strconv.Itoa(approved.Id))
	form.Set("comment", "Changed after approval")

	req, err := http.NewRequest(
		http.MethodPost,
		h.URL("/users/"+strconv.Itoa(h.Data.PrimaryUser.Id)+"/services/"+h.Data.Service.ServiceKey+"/posts/"+approved.PostKey+"/comments/"),
		strings.NewReader(form.Encode()),
	)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	res, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}

	assert.Equal(t, http.StatusForbidden, res.StatusCode)
	reloaded, err := h.Store.GetComment(approved.Id)
	if err != nil {
		t.Fatal(err)
	}
	assert.Equal(t, approved.Comment, reloaded.Comment)
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
