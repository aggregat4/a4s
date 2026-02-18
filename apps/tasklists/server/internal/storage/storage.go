package storage

import "context"

// Store defines the persistence contract for sync state.
//
// Why this exists:
// - HTTP handlers should express sync behavior, not SQL details.
// - Cursor tracking and generation handling need consistent semantics across all
//   endpoints so compaction and reset behavior remain safe.
// - Tests can validate protocol behavior via this abstraction.
type Store interface {
	// Init prepares schema/connection state needed before serving requests.
	Init(ctx context.Context) error

	// Close releases resources held by the storage backend.
	Close() error

	// InsertOps stores a batch of client operations for the active dataset
	// generation and returns the latest server sequence for that generation.
	//
	// Why: push responses need the authoritative server cursor so clients can
	// advance safely without re-reading old ops.
	InsertOps(ctx context.Context, userID string, ops []Op) (int64, error)

	// GetOpsSince returns operations with serverSeq > since for the user's active
	// dataset generation, along with the latest serverSeq.
	//
	// Why: pull and bootstrap both need incremental replay with a monotonic
	// cursor, even when no new ops were returned.
	GetOpsSince(ctx context.Context, userID string, since int64) ([]Op, int64, error)

	// GetActiveDatasetGenerationKey returns the key of the user's active dataset
	// generation, creating initial generation state when missing.
	//
	// Why: every sync request must be validated against the active generation to
	// detect reset/import boundaries.
	GetActiveDatasetGenerationKey(ctx context.Context, userID string) (string, error)

	// GetSnapshot returns the active snapshot blob and generation metadata.
	//
	// Why: bootstrap and generation-mismatch responses require an opaque snapshot
	// payload clients can fully restore from.
	GetSnapshot(ctx context.Context, userID string) (Snapshot, error)

	// ReplaceSnapshot atomically installs a new generation snapshot, resets op log
	// state for that user, and clears client cursors.
	//
	// Why: import/reset must establish a clean generation boundary so old cursors
	// and ops cannot leak into the new dataset.
	ReplaceSnapshot(ctx context.Context, userID string, snapshot Snapshot) error

	// TouchClient upserts client presence without advancing the cursor.
	//
	// Why: this keeps a client record alive (for heartbeat/registration use-cases)
	// when no authoritative server sequence update is available.
	TouchClient(ctx context.Context, userID string, clientID string) error

	// UpdateClientCursor upserts client cursor progress to at least serverSeq
	// (monotonic, never regressing).
	//
	// Why: compaction safety depends on the minimum known client cursor. Push and
	// pull both establish authoritative progress points and should call this.
	UpdateClientCursor(ctx context.Context, userID string, clientID string, serverSeq int64) error
}
