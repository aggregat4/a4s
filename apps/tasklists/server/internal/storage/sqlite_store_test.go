package storage

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"
	"time"
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
	userID := "user-1"
	ops := []Op{
		{
			Scope:    "list",
			Resource: "list-1",
			Actor:    "actor-1",
			Clock:    1,
			Payload:  []byte(`{"type":"insert","itemId":"item-1"}`),
		},
	}
	seq, err := store.InsertOps(context.Background(), userID, ops)
	if err != nil {
		t.Fatalf("insert ops: %v", err)
	}
	if seq == 0 {
		t.Fatalf("serverSeq should advance")
	}
	pulled, seq2, err := store.GetOpsSince(context.Background(), userID, 0)
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
	userID := "user-1"
	ops := []Op{
		{
			Scope:    "list",
			Resource: "list-1",
			Actor:    "actor-1",
			Clock:    1,
			Payload:  []byte(`{"type":"insert","itemId":"item-1"}`),
		},
	}
	if _, err := store.InsertOps(context.Background(), userID, ops); err != nil {
		t.Fatalf("insert ops: %v", err)
	}
	if _, err := store.InsertOps(context.Background(), userID, ops); err != nil {
		t.Fatalf("insert ops: %v", err)
	}
	pulled, _, err := store.GetOpsSince(context.Background(), userID, 0)
	if err != nil {
		t.Fatalf("get ops: %v", err)
	}
	if len(pulled) != 1 {
		t.Fatalf("ops length: got %d", len(pulled))
	}
}

func TestClientCursorTracking(t *testing.T) {
	store := newSQLiteStore(t)
	userID := "user-1"
	if err := store.TouchClient(context.Background(), userID, "client-1"); err != nil {
		t.Fatalf("touch client: %v", err)
	}
	if err := store.UpdateClientCursor(context.Background(), userID, "client-1", 5); err != nil {
		t.Fatalf("update cursor: %v", err)
	}
	if err := store.UpdateClientCursor(context.Background(), userID, "client-1", 3); err != nil {
		t.Fatalf("cursor should not regress: %v", err)
	}
}

func TestSnapshotReplaceResetsOps(t *testing.T) {
	store := newSQLiteStore(t)
	userID := "user-1"
	ctx := context.Background()
	if _, err := store.InsertOps(ctx, userID, []Op{
		{
			Scope:    "list",
			Resource: "list-1",
			Actor:    "actor-1",
			Clock:    1,
			Payload:  []byte(`{"type":"insert","itemId":"item-1"}`),
		},
	}); err != nil {
		t.Fatalf("insert ops: %v", err)
	}
	if err := store.ReplaceSnapshot(ctx, userID, Snapshot{
		DatasetGenerationKey: "dataset-new",
		Blob:                 `{"schema":"net.aggregat4.tasklist.snapshot@v1","data":{"registry":{"clock":0,"entries":[]},"lists":[]}}`,
	}); err != nil {
		t.Fatalf("replace snapshot: %v", err)
	}
	ops, _, err := store.GetOpsSince(ctx, userID, 0)
	if err != nil {
		t.Fatalf("get ops: %v", err)
	}
	if len(ops) != 0 {
		t.Fatalf("ops should be cleared after snapshot replace")
	}
	snapshot, err := store.GetSnapshot(ctx, userID)
	if err != nil {
		t.Fatalf("get snapshot: %v", err)
	}
	if snapshot.DatasetGenerationKey != "dataset-new" {
		t.Fatalf("snapshot datasetGenerationKey mismatch: %s", snapshot.DatasetGenerationKey)
	}
}

// A request cancelled in the middle of a write must not leave its transaction
// open on the single write connection, or every later write fails with
// "cannot start a transaction within a transaction".
func TestCancelledWritesDoNotBreakLaterWrites(t *testing.T) {
	store := newSQLiteStore(t)
	userID := "user-1"
	ops := make([]Op, 500)
	for i := range ops {
		ops[i] = Op{
			Scope:    "list",
			Resource: "list-1",
			Actor:    "actor-1",
			Clock:    int64(i + 1),
			Payload:  []byte(`{"type":"insert"}`),
		}
	}
	if _, err := store.InsertOps(context.Background(), userID, ops[:1]); err != nil {
		t.Fatalf("seed ops: %v", err)
	}

	for attempt := range 200 {
		ctx, cancel := context.WithCancel(context.Background())
		go func() {
			time.Sleep(time.Duration(attempt%40) * 50 * time.Microsecond)
			cancel()
		}()
		_, _ = store.InsertOps(ctx, userID, ops)
		cancel()

		if err := store.ReplaceSnapshot(context.Background(), userID, Snapshot{
			DatasetGenerationKey: fmt.Sprintf("generation-%d", attempt),
			Blob:                 `{}`,
		}); err != nil {
			t.Fatalf("write after cancelled insert %d: %v", attempt, err)
		}
	}
}
