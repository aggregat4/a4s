package repository

import (
	"errors"
	"testing"

	"aggregat4/go-commentservice/internal/domain"
	"github.com/aggregat4/go-baselib/crypto"
	"github.com/aggregat4/go-baselib/lang"
	_ "github.com/mattn/go-sqlite3"
)

const testEncryptionKey = "12345678901234567890123456789012"

func newTestStore(t *testing.T) *Store {
	t.Helper()

	aead, err := crypto.CreateAes256GcmAead([]byte(testEncryptionKey))
	if err != nil {
		t.Fatalf("failed to create cipher: %v", err)
	}

	store := &Store{Cipher: aead}
	if err := store.InitAndVerifyDb(CreateInMemoryDbUrl()); err != nil {
		t.Fatalf("failed to init db: %v", err)
	}

	t.Cleanup(func() {
		_ = store.Close()
	})

	return store
}

func TestStoreCreateAndFetchService(t *testing.T) {
	store := newTestStore(t)

	serviceID, err := store.CreateService("blog1", "https://blog1.example.com")
	if err != nil {
		t.Fatalf("CreateService failed: %v", err)
	}

	service, err := store.GetServiceForKey("blog1")
	if err != nil {
		t.Fatalf("GetServiceForKey failed: %v", err)
	}

	if service.Id != serviceID || service.ServiceKey != "blog1" || service.Origin != "https://blog1.example.com" {
		t.Fatalf("unexpected service: %+v", service)
	}

	byID, err := store.FindServiceById(serviceID)
	if err != nil {
		t.Fatalf("FindServiceById failed: %v", err)
	}

	if byID.Id != serviceID || byID.ServiceKey != "blog1" {
		t.Fatalf("FindServiceById returned %+v", byID)
	}
}

func TestStoreFindOrCreateUserByExternalID(t *testing.T) {
	store := newTestStore(t)

	user, err := store.FindOrCreateUserByExternalId("user-123")
	if err != nil {
		t.Fatalf("FindOrCreateUserByExternalId create failed: %v", err)
	}

	if user.Id == 0 || user.ExternalUserId != "user-123" {
		t.Fatalf("unexpected user: %+v", user)
	}

	revisit, err := store.FindOrCreateUserByExternalId("user-123")
	if err != nil {
		t.Fatalf("FindOrCreateUserByExternalId lookup failed: %v", err)
	}

	if revisit.Id != user.Id {
		t.Fatalf("expected same user id, got %d want %d", revisit.Id, user.Id)
	}
}

func TestStoreCommentQueries(t *testing.T) {
	store := newTestStore(t)

	serviceID, err := store.CreateService("blog1", "https://blog1.example.com")
	if err != nil {
		t.Fatalf("CreateService failed: %v", err)
	}

	userID, err := store.CreateUserWithExternalId("commenter")
	if err != nil {
		t.Fatalf("CreateUserWithExternalId failed: %v", err)
	}

	approvedID, err := store.CreateComment(
		domain.CommentStatusApproved,
		serviceID,
		"blog1",
		userID,
		"post-1",
		"Great post!",
		"Commenter",
		"https://commenter.example.com",
		"",
	)
	if err != nil {
		t.Fatalf("CreateComment failed: %v", err)
	}

	_, err = store.CreateComment(
		domain.CommentStatusPendingApproval,
		serviceID,
		"blog1",
		userID,
		"post-1",
		"Pending comment",
		"Commenter",
		"",
		"",
	)
	if err != nil {
		t.Fatalf("CreateComment (pending) failed: %v", err)
	}

	approved, err := store.GetCommentsByServiceAndStatus("blog1", []domain.CommentStatus{domain.CommentStatusApproved})
	if err != nil {
		t.Fatalf("GetCommentsByServiceAndStatus failed: %v", err)
	}

	if len(approved) != 1 {
		t.Fatalf("expected 1 approved comment, got %d", len(approved))
	}

	if approved[0].Id != approvedID || approved[0].Comment != "Great post!" || approved[0].Name != "Commenter" {
		t.Fatalf("unexpected approved comment: %+v", approved[0])
	}

	sameComment, err := store.GetComment(approvedID)
	if err != nil {
		t.Fatalf("GetComment failed: %v", err)
	}

	if sameComment.Comment != "Great post!" || sameComment.Status != domain.CommentStatusApproved {
		t.Fatalf("GetComment mismatch: %+v", sameComment)
	}
}

func TestStoreGetAllServices(t *testing.T) {
	store := newTestStore(t)

	_, err := store.CreateService("blog1", "https://blog1.example.com")
	if err != nil {
		t.Fatalf("CreateService failed: %v", err)
	}
	_, err = store.CreateService("blog2", "https://blog2.example.com")
	if err != nil {
		t.Fatalf("CreateService failed: %v", err)
	}

	services, err := store.GetAllServices()
	if err != nil {
		t.Fatalf("GetAllServices failed: %v", err)
	}

	if len(services) != 2 {
		t.Fatalf("expected 2 services, got %d", len(services))
	}

	keys := map[string]bool{}
	for _, svc := range services {
		keys[svc.ServiceKey] = true
	}

	if !keys["blog1"] || !keys["blog2"] {
		t.Fatalf("missing expected service keys: %v", keys)
	}
}

func TestStoreUpdateCommentMarksEdited(t *testing.T) {
	store := newTestStore(t)

	serviceID, err := store.CreateService("blog1", "https://blog1.example.com")
	if err != nil {
		t.Fatalf("CreateService failed: %v", err)
	}

	userID, err := store.CreateUser()
	if err != nil {
		t.Fatalf("CreateUser failed: %v", err)
	}

	commentID, err := store.CreateComment(
		domain.CommentStatusPendingApproval,
		serviceID,
		"blog1",
		userID,
		"post-1",
		"First draft",
		"Author",
		"https://example.com",
		"",
	)
	if err != nil {
		t.Fatalf("CreateComment failed: %v", err)
	}

	if err := store.UpdateComment(
		commentID,
		domain.CommentStatusApproved,
		"Updated body",
		"Updated Author",
		"https://updated.example.com",
		"https://parent.example.com",
	); err != nil {
		t.Fatalf("UpdateComment failed: %v", err)
	}

	updated, err := store.GetComment(commentID)
	if err != nil {
		t.Fatalf("GetComment failed: %v", err)
	}

	if updated.Status != domain.CommentStatusApproved {
		t.Fatalf("expected status approved, got %v", updated.Status)
	}
	if updated.Comment != "Updated body" || updated.Name != "Updated Author" || updated.Website != "https://updated.example.com" {
		t.Fatalf("comment not updated correctly: %+v", updated)
	}
	if updated.ParentUrl != "https://parent.example.com" {
		t.Fatalf("parent url not updated: %+v", updated)
	}
	if !updated.Edited {
		t.Fatalf("expected comment to be marked edited")
	}
}

func TestStoreDeleteCommentMissingReturnsNotFound(t *testing.T) {
	store := newTestStore(t)

	err := store.DeleteComment(12345)
	if err == nil {
		t.Fatalf("expected error deleting unknown comment")
	}
	if !errors.Is(err, lang.ErrNotFound) {
		t.Fatalf("expected lang.ErrNotFound, got %v", err)
	}
}

func TestStoreGetCommentsForPostOnlyReturnsApproved(t *testing.T) {
	store := newTestStore(t)

	serviceID, err := store.CreateService("blog1", "https://blog1.example.com")
	if err != nil {
		t.Fatalf("CreateService failed: %v", err)
	}

	userID, err := store.CreateUser()
	if err != nil {
		t.Fatalf("CreateUser failed: %v", err)
	}

	approvedID, err := store.CreateComment(
		domain.CommentStatusApproved,
		serviceID,
		"blog1",
		userID,
		"post-1",
		"Visible",
		"Author",
		"",
		"",
	)
	if err != nil {
		t.Fatalf("CreateComment failed: %v", err)
	}

	_, err = store.CreateComment(
		domain.CommentStatusPendingApproval,
		serviceID,
		"blog1",
		userID,
		"post-1",
		"Hidden",
		"Author",
		"",
		"",
	)
	if err != nil {
		t.Fatalf("CreateComment pending failed: %v", err)
	}

	comments, err := store.GetCommentsForPost(serviceID, "post-1")
	if err != nil {
		t.Fatalf("GetCommentsForPost failed: %v", err)
	}

	if len(comments) != 1 {
		t.Fatalf("expected 1 approved comment, got %d", len(comments))
	}
	if comments[0].Id != approvedID {
		t.Fatalf("unexpected comment returned: %+v", comments[0])
	}
}
