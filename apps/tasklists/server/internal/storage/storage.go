package storage

import "context"

// Store provides access to the op log and client cursor tracking.
type Store interface {
	Init(ctx context.Context) error
	Close() error
	InsertOps(ctx context.Context, userID string, ops []Op) (int64, error)
	GetOpsSince(ctx context.Context, userID string, since int64) ([]Op, int64, error)
	GetActiveDatasetGenerationKey(ctx context.Context, userID string) (string, error)
	GetSnapshot(ctx context.Context, userID string) (Snapshot, error)
	ReplaceSnapshot(ctx context.Context, userID string, snapshot Snapshot) error
	TouchClient(ctx context.Context, userID string, clientID string) error
	UpdateClientCursor(ctx context.Context, userID string, clientID string, serverSeq int64) error
}
