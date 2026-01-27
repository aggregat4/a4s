package storage

import "context"

// Store provides access to the op log and client cursor tracking.
type Store interface {
	Init(ctx context.Context) error
	Close() error
	InsertOps(ctx context.Context, ops []Op) (int64, error)
	GetOpsSince(ctx context.Context, since int64) ([]Op, int64, error)
	GetActiveDatasetGenerationKey(ctx context.Context) (string, error)
	GetSnapshot(ctx context.Context) (Snapshot, error)
	ReplaceSnapshot(ctx context.Context, snapshot Snapshot) error
	TouchClient(ctx context.Context, clientID string) error
	UpdateClientCursor(ctx context.Context, clientID string, serverSeq int64) error
}
