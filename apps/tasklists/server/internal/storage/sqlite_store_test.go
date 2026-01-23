package storage

import (
	"context"
	"path/filepath"
	"testing"
)

func newSQLiteStore(t *testing.T) *SQLiteStore {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "test.db")
	store, err := OpenSQLite(path)
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	if err := store.Init(context.Background()); err != nil {
		t.Fatalf("init sqlite: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}

func TestInsertAndGetOps(t *testing.T) {
	store := newSQLiteStore(t)
	ops := []Op{
		{
			Scope:    "list",
			Resource: "list-1",
			Actor:    "actor-1",
			Clock:    1,
			Payload:  []byte(`{"type":"insert","itemId":"item-1"}`),
		},
	}
	seq, err := store.InsertOps(context.Background(), ops)
	if err != nil {
		t.Fatalf("insert ops: %v", err)
	}
	if seq == 0 {
		t.Fatalf("serverSeq should advance")
	}
	pulled, seq2, err := store.GetOpsSince(context.Background(), 0)
	if err != nil {
		t.Fatalf("get ops: %v", err)
	}
	if seq2 != seq {
		t.Fatalf("serverSeq mismatch: %d vs %d", seq2, seq)
	}
	if len(pulled) != 1 {
		t.Fatalf("ops length: got %d", len(pulled))
	}
}

func TestInsertOpsDedupe(t *testing.T) {
	store := newSQLiteStore(t)
	ops := []Op{
		{
			Scope:    "list",
			Resource: "list-1",
			Actor:    "actor-1",
			Clock:    1,
			Payload:  []byte(`{"type":"insert","itemId":"item-1"}`),
		},
	}
	if _, err := store.InsertOps(context.Background(), ops); err != nil {
		t.Fatalf("insert ops: %v", err)
	}
	if _, err := store.InsertOps(context.Background(), ops); err != nil {
		t.Fatalf("insert ops: %v", err)
	}
	pulled, _, err := store.GetOpsSince(context.Background(), 0)
	if err != nil {
		t.Fatalf("get ops: %v", err)
	}
	if len(pulled) != 1 {
		t.Fatalf("ops length: got %d", len(pulled))
	}
}

func TestClientCursorTracking(t *testing.T) {
	store := newSQLiteStore(t)
	if err := store.TouchClient(context.Background(), "client-1"); err != nil {
		t.Fatalf("touch client: %v", err)
	}
	if err := store.UpdateClientCursor(context.Background(), "client-1", 5); err != nil {
		t.Fatalf("update cursor: %v", err)
	}
	if err := store.UpdateClientCursor(context.Background(), "client-1", 3); err != nil {
		t.Fatalf("cursor should not regress: %v", err)
	}
}
