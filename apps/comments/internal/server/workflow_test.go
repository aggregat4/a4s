package server

import (
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"aggregat4/go-commentservice/internal/domain"
	"github.com/stretchr/testify/require"
)

func TestCommentLifecycleHappyPath(t *testing.T) {
	h := NewServerHarness(t)

	// Step 1: authenticated user submits a new comment that should start pending approval.
	userClient := h.NewClient(false)
	userCookie := h.MustUserSessionCookie(h.Data.AdditionalUser.Id)
	h.SetCookie(userClient, userCookie)

	commentBody := "Loved the new post!"
	form := url.Values{}
	form.Set("comment", commentBody)
	form.Set("name", "Happy User")
	form.Set("website", "https://reader.example.com")
	form.Set("parentUrl", "https://blog.example.com/posts/2")

	submitPath := fmt.Sprintf(
		"/users/%d/services/%s/posts/%s/comments/",
		h.Data.AdditionalUser.Id,
		h.Data.Service.ServiceKey,
		testPostKeySecond,
	)

	req, err := http.NewRequest(http.MethodPost, h.URL(submitPath), strings.NewReader(form.Encode()))
	require.NoError(t, err)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Origin", h.Data.Service.Origin)

	res, err := userClient.Do(req)
	require.NoError(t, err)
	require.Equal(t, http.StatusFound, res.StatusCode)
	require.Equal(t, fmt.Sprintf("/services/%s/posts/%s/comments/", h.Data.Service.ServiceKey, testPostKeySecond), res.Header.Get("Location"))

	userComments, err := h.Store.GetCommentsForUser(h.Data.AdditionalUser.Id)
	require.NoError(t, err)

	var pending domain.Comment
	for _, c := range userComments {
		if c.PostKey == testPostKeySecond && c.Comment == commentBody {
			pending = c
			break
		}
	}
	require.NotZero(t, pending.Id, "expected freshly created pending comment")
	require.Equal(t, domain.CommentStatusPendingApproval, pending.Status)

	// Step 2: a service admin approves the comment.
	adminClient := h.NewClient(false)
	adminCookie := h.MustAdminSessionCookie("admin-user", []string{"admin-" + h.Data.Service.ServiceKey})
	h.SetCookie(adminClient, adminCookie)

	approvePath := fmt.Sprintf("/admin/%s/comments/%d/approve", h.Data.Service.ServiceKey, pending.Id)
	approveReq, err := http.NewRequest(http.MethodPost, h.URL(approvePath), strings.NewReader(""))
	require.NoError(t, err)
	approveReq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	approveReq.Header.Set("Origin", h.Data.Service.Origin)

	approveRes, err := adminClient.Do(approveReq)
	require.NoError(t, err)
	require.Equal(t, http.StatusFound, approveRes.StatusCode)
	require.Equal(t, fmt.Sprintf("/admin/%s/comments", h.Data.Service.ServiceKey), approveRes.Header.Get("Location"))

	updated, err := h.Store.GetComment(pending.Id)
	require.NoError(t, err)
	require.Equal(t, domain.CommentStatusApproved, updated.Status)

	// Step 3: the approved comment surfaces on the public page and in the super-admin dashboard.
	publicClient := h.NewClient(true)
	publicRes, err := publicClient.Get(h.URL(fmt.Sprintf("/services/%s/posts/%s/comments/", h.Data.Service.ServiceKey, testPostKeySecond)))
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, publicRes.StatusCode)
	require.Contains(t, readBody(publicRes), commentBody)

	superClient := h.NewClient(true)
	superCookie := h.MustAdminSessionCookie("super-user", []string{"superadmin"})
	h.SetCookie(superClient, superCookie)

	superRes, err := superClient.Get(h.URL("/superadmin/comments"))
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, superRes.StatusCode)
	body := readBody(superRes)
	require.Contains(t, body, commentBody)
	require.Contains(t, body, h.Data.Service.ServiceKey)
}
