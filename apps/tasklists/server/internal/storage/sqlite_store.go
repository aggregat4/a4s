package storage

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	_ "modernc.org/sqlite"
)

const schema = `
CREATE TABLE IF NOT EXISTS ops (
	server_seq INTEGER PRIMARY KEY AUTOINCREMENT,
	scope TEXT NOT NULL,
	resource_id TEXT NOT NULL,
	actor TEXT NOT NULL,
	clock INTEGER NOT NULL,
	payload TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ops_dedupe
ON ops(actor, clock, scope, resource_id);

CREATE TABLE IF NOT EXISTS clients (
	client_id TEXT PRIMARY KEY,
	last_seen_server_seq INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
`

// SQLiteStore is a SQLite-backed implementation of Store.
type SQLiteStore struct {
	db *sql.DB
}

func OpenSQLite(path string) (*SQLiteStore, error) {
	if path == "" {
		return nil, errors.New("sqlite path is required")
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	return &SQLiteStore{db: db}, nil
}

func (s *SQLiteStore) Init(ctx context.Context) error {
	if _, err := s.db.ExecContext(ctx, "PRAGMA foreign_keys = ON;"); err != nil {
		return fmt.Errorf("enable foreign keys: %w", err)
	}
	if _, err := s.db.ExecContext(ctx, "PRAGMA journal_mode = WAL;"); err != nil {
		return fmt.Errorf("enable wal: %w", err)
	}
	_, err := s.db.ExecContext(ctx, schema)
	if err != nil {
		return fmt.Errorf("init schema: %w", err)
	}
	return nil
}

func (s *SQLiteStore) Close() error {
	return s.db.Close()
}

func (s *SQLiteStore) InsertOps(ctx context.Context, ops []Op) (int64, error) {
	if len(ops) == 0 {
		return s.maxServerSeq(ctx)
	}
	transaction, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("begin tx: %w", err)
	}
	stmt, err := transaction.PrepareContext(ctx, `
		INSERT OR IGNORE INTO ops (scope, resource_id, actor, clock, payload)
		VALUES (?, ?, ?, ?, ?)
	`)
	if err != nil {
		_ = transaction.Rollback()
		return 0, fmt.Errorf("prepare insert: %w", err)
	}
	defer stmt.Close()

	for _, op := range ops {
		if op.Scope == "" || op.Resource == "" || op.Actor == "" || op.Clock <= 0 {
			_ = transaction.Rollback()
			return 0, fmt.Errorf("invalid op metadata: scope=%q resource=%q actor=%q clock=%d", op.Scope, op.Resource, op.Actor, op.Clock)
		}
		if _, err := stmt.ExecContext(ctx, op.Scope, op.Resource, op.Actor, op.Clock, string(op.Payload)); err != nil {
			_ = transaction.Rollback()
			return 0, fmt.Errorf("insert op: %w", err)
		}
	}
	if err := transaction.Commit(); err != nil {
		return 0, fmt.Errorf("commit ops: %w", err)
	}
	return s.maxServerSeq(ctx)
}

func (s *SQLiteStore) GetOpsSince(ctx context.Context, since int64) ([]Op, int64, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT server_seq, scope, resource_id, actor, clock, payload
		FROM ops
		WHERE server_seq > ?
		ORDER BY server_seq ASC
	`, since)
	if err != nil {
		return nil, 0, fmt.Errorf("query ops: %w", err)
	}
	defer rows.Close()

	ops := make([]Op, 0)
	var maxSeq int64
	for rows.Next() {
		var op Op
		var payload string
		if err := rows.Scan(&op.ServerSeq, &op.Scope, &op.Resource, &op.Actor, &op.Clock, &payload); err != nil {
			return nil, 0, fmt.Errorf("scan op: %w", err)
		}
		op.Payload = []byte(payload)
		if op.ServerSeq > maxSeq {
			maxSeq = op.ServerSeq
		}
		ops = append(ops, op)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("iterate ops: %w", err)
	}
	if maxSeq == 0 {
		maxSeq, err = s.maxServerSeq(ctx)
		if err != nil {
			return nil, 0, err
		}
	}
	return ops, maxSeq, nil
}

func (s *SQLiteStore) TouchClient(ctx context.Context, clientID string) error {
	if clientID == "" {
		return errors.New("clientId is required")
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO clients (client_id, last_seen_server_seq, updated_at)
		VALUES (?, 0, ?)
		ON CONFLICT(client_id) DO UPDATE SET updated_at = excluded.updated_at
	`, clientID, time.Now().Unix())
	if err != nil {
		return fmt.Errorf("touch client: %w", err)
	}
	return nil
}

func (s *SQLiteStore) UpdateClientCursor(ctx context.Context, clientID string, serverSeq int64) error {
	if clientID == "" {
		return errors.New("clientId is required")
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO clients (client_id, last_seen_server_seq, updated_at)
		VALUES (?, ?, ?)
		ON CONFLICT(client_id) DO UPDATE SET
			last_seen_server_seq = MAX(clients.last_seen_server_seq, excluded.last_seen_server_seq),
			updated_at = excluded.updated_at
	`, clientID, serverSeq, time.Now().Unix())
	if err != nil {
		return fmt.Errorf("update client cursor: %w", err)
	}
	return nil
}

func (s *SQLiteStore) maxServerSeq(ctx context.Context) (int64, error) {
	var maxSeq int64
	row := s.db.QueryRowContext(ctx, "SELECT COALESCE(MAX(server_seq), 0) FROM ops")
	if err := row.Scan(&maxSeq); err != nil {
		return 0, fmt.Errorf("max server seq: %w", err)
	}
	return maxSeq, nil
}
