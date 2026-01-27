package storage

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	_ "modernc.org/sqlite"
)

const schema = `
CREATE TABLE IF NOT EXISTS snapshots (
	dataset_generation_id INTEGER PRIMARY KEY,
	dataset_generation_key TEXT NOT NULL UNIQUE,
	snapshot_blob TEXT NOT NULL,
	created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	active_dataset_generation_id INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	FOREIGN KEY(active_dataset_generation_id) REFERENCES snapshots(dataset_generation_id)
);

CREATE TABLE IF NOT EXISTS ops (
	server_seq INTEGER PRIMARY KEY AUTOINCREMENT,
	dataset_generation_id INTEGER NOT NULL,
	scope TEXT NOT NULL,
	resource_id TEXT NOT NULL,
	actor TEXT NOT NULL,
	clock INTEGER NOT NULL,
	payload TEXT NOT NULL,
	FOREIGN KEY(dataset_generation_id) REFERENCES snapshots(dataset_generation_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ops_dedupe
ON ops(dataset_generation_id, actor, clock, scope, resource_id);

CREATE INDEX IF NOT EXISTS idx_ops_dataset_seq
ON ops(dataset_generation_id, server_seq);

CREATE TABLE IF NOT EXISTS clients (
	client_id TEXT NOT NULL,
	last_seen_server_seq INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (client_id)
);
`

// SQLiteStore is a SQLite-backed implementation of Store.
type SQLiteStore struct {
	dbWrite *sql.DB
	dbRead  *sql.DB
	path    string
}

func OpenSQLite(path string) (*SQLiteStore, error) {
	if path == "" {
		return nil, errors.New("sqlite path is required")
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	return &SQLiteStore{dbWrite: db, path: path}, nil
}

func (s *SQLiteStore) Init(ctx context.Context) error {
	if _, err := s.dbWrite.ExecContext(ctx, "PRAGMA foreign_keys = ON;"); err != nil {
		return fmt.Errorf("enable foreign keys: %w", err)
	}
	if _, err := s.dbWrite.ExecContext(ctx, "PRAGMA journal_mode = WAL;"); err != nil {
		return fmt.Errorf("enable wal: %w", err)
	}
	if _, err := s.dbWrite.ExecContext(ctx, "PRAGMA synchronous = NORMAL;"); err != nil {
		return fmt.Errorf("set synchronous: %w", err)
	}
	if _, err := s.dbWrite.ExecContext(ctx, "PRAGMA busy_timeout = 5000;"); err != nil {
		return fmt.Errorf("set busy timeout: %w", err)
	}
	_, err := s.dbWrite.ExecContext(ctx, schema)
	if err != nil {
		return fmt.Errorf("init schema: %w", err)
	}
	if err := s.ensureActiveSnapshot(ctx); err != nil {
		return err
	}
	if s.dbRead == nil {
		readDB, err := sql.Open("sqlite", s.path)
		if err != nil {
			return fmt.Errorf("open read sqlite: %w", err)
		}
		readDB.SetMaxOpenConns(10)
		readDB.SetMaxIdleConns(10)
		if _, err := readDB.ExecContext(ctx, "PRAGMA query_only = ON;"); err != nil {
			return fmt.Errorf("set query only: %w", err)
		}
		if _, err := readDB.ExecContext(ctx, "PRAGMA busy_timeout = 5000;"); err != nil {
			return fmt.Errorf("set read busy timeout: %w", err)
		}
		if _, err := readDB.ExecContext(ctx, "PRAGMA foreign_keys = ON;"); err != nil {
			return fmt.Errorf("enable read foreign keys: %w", err)
		}
		s.dbRead = readDB
	}
	return nil
}

func (s *SQLiteStore) Close() error {
	var err error
	if s.dbWrite != nil {
		err = s.dbWrite.Close()
	}
	if s.dbRead != nil {
		if closeErr := s.dbRead.Close(); closeErr != nil && err == nil {
			err = closeErr
		}
	}
	return err
}

func (s *SQLiteStore) InsertOps(ctx context.Context, ops []Op) (int64, error) {
	if len(ops) == 0 {
		return s.maxServerSeq(ctx)
	}
	datasetGenerationID, err := s.getActiveDatasetGenerationID(ctx)
	if err != nil {
		return 0, err
	}
	conn, err := s.dbWrite.Conn(ctx)
	if err != nil {
		return 0, fmt.Errorf("get write conn: %w", err)
	}
	defer conn.Close()

	if _, err := conn.ExecContext(ctx, "BEGIN IMMEDIATE;"); err != nil {
		return 0, fmt.Errorf("begin immediate: %w", err)
	}

	committed := false
	defer func() {
		if committed {
			return
		}
		_, _ = conn.ExecContext(ctx, "ROLLBACK;")
	}()

	stmt, err := conn.PrepareContext(ctx, `
		INSERT OR IGNORE INTO ops (dataset_generation_id, scope, resource_id, actor, clock, payload)
		VALUES (?, ?, ?, ?, ?, ?)
	`)
	if err != nil {
		return 0, fmt.Errorf("prepare insert: %w", err)
	}
	defer stmt.Close()

	for _, op := range ops {
		if op.Scope == "" || op.Resource == "" || op.Actor == "" || op.Clock <= 0 {
			return 0, fmt.Errorf("invalid op metadata: scope=%q resource=%q actor=%q clock=%d", op.Scope, op.Resource, op.Actor, op.Clock)
		}
		if _, err := stmt.ExecContext(ctx, datasetGenerationID, op.Scope, op.Resource, op.Actor, op.Clock, string(op.Payload)); err != nil {
			return 0, fmt.Errorf("insert op: %w", err)
		}
	}
	if _, err := conn.ExecContext(ctx, "COMMIT;"); err != nil {
		return 0, fmt.Errorf("commit ops: %w", err)
	}
	committed = true
	return s.maxServerSeq(ctx)
}

func (s *SQLiteStore) GetOpsSince(ctx context.Context, since int64) ([]Op, int64, error) {
	datasetGenerationID, err := s.getActiveDatasetGenerationID(ctx)
	if err != nil {
		return nil, 0, err
	}
	db := s.dbRead
	if db == nil {
		db = s.dbWrite
	}
	rows, err := db.QueryContext(ctx, `
		SELECT server_seq, scope, resource_id, actor, clock, payload
		FROM ops
		WHERE dataset_generation_id = ? AND server_seq > ?
		ORDER BY server_seq ASC
	`, datasetGenerationID, since)
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
	_, err := s.dbWrite.ExecContext(ctx, `
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
	_, err := s.dbWrite.ExecContext(ctx, `
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
	datasetGenerationID, err := s.getActiveDatasetGenerationID(ctx)
	if err != nil {
		return 0, err
	}
	var maxSeq int64
	db := s.dbRead
	if db == nil {
		db = s.dbWrite
	}
	row := db.QueryRowContext(ctx, "SELECT COALESCE(MAX(server_seq), 0) FROM ops WHERE dataset_generation_id = ?", datasetGenerationID)
	if err := row.Scan(&maxSeq); err != nil {
		return 0, fmt.Errorf("max server seq: %w", err)
	}
	return maxSeq, nil
}

func (s *SQLiteStore) ensureActiveSnapshot(ctx context.Context) error {
	row := s.dbWrite.QueryRowContext(ctx, "SELECT active_dataset_generation_id FROM meta WHERE id = 1")
	var datasetGenerationID int64
	err := row.Scan(&datasetGenerationID)
	if err == nil && datasetGenerationID != 0 {
		return nil
	}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("check meta: %w", err)
	}
	newKey := uuid.NewString()
	now := time.Now().Unix()
	result, err := s.dbWrite.ExecContext(ctx, `
		INSERT INTO snapshots (dataset_generation_key, snapshot_blob, created_at)
		VALUES (?, ?, ?)
	`, newKey, "", now)
	if err != nil {
		return fmt.Errorf("insert snapshot: %w", err)
	}
	datasetGenerationID, err = result.LastInsertId()
	if err != nil {
		return fmt.Errorf("snapshot id: %w", err)
	}
	if _, err := s.dbWrite.ExecContext(ctx, `
		INSERT INTO meta (id, active_dataset_generation_id, updated_at)
		VALUES (1, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			active_dataset_generation_id = excluded.active_dataset_generation_id,
			updated_at = excluded.updated_at
	`, datasetGenerationID, now); err != nil {
		return fmt.Errorf("insert meta: %w", err)
	}
	return nil
}

func (s *SQLiteStore) GetActiveDatasetGenerationKey(ctx context.Context) (string, error) {
	db := s.dbRead
	if db == nil {
		db = s.dbWrite
	}
	row := db.QueryRowContext(ctx, `
		SELECT s.dataset_generation_key
		FROM meta m
		JOIN snapshots s ON s.dataset_generation_id = m.active_dataset_generation_id
		WHERE m.id = 1
	`)
	var datasetGenerationKey string
	if err := row.Scan(&datasetGenerationKey); err != nil {
		return "", fmt.Errorf("load active dataset_generation_key: %w", err)
	}
	return datasetGenerationKey, nil
}

func (s *SQLiteStore) getActiveDatasetGenerationID(ctx context.Context) (int64, error) {
	db := s.dbRead
	if db == nil {
		db = s.dbWrite
	}
	row := db.QueryRowContext(ctx, `
		SELECT active_dataset_generation_id
		FROM meta
		WHERE id = 1
	`)
	var datasetGenerationID int64
	if err := row.Scan(&datasetGenerationID); err != nil {
		return 0, fmt.Errorf("load active dataset_generation_id: %w", err)
	}
	return datasetGenerationID, nil
}

func (s *SQLiteStore) GetSnapshot(ctx context.Context) (Snapshot, error) {
	var snapshot Snapshot
	db := s.dbRead
	if db == nil {
		db = s.dbWrite
	}
	row := db.QueryRowContext(ctx, `
		SELECT s.dataset_generation_id, s.dataset_generation_key, s.snapshot_blob
		FROM snapshots s
		JOIN meta m ON m.active_dataset_generation_id = s.dataset_generation_id
		WHERE m.id = 1
	`)
	if err := row.Scan(&snapshot.DatasetGenerationID, &snapshot.DatasetGenerationKey, &snapshot.Blob); err != nil {
		return Snapshot{}, fmt.Errorf("load snapshot: %w", err)
	}
	return snapshot, nil
}

func (s *SQLiteStore) ReplaceSnapshot(ctx context.Context, snapshot Snapshot) error {
	if snapshot.DatasetGenerationKey == "" {
		return errors.New("datasetGenerationKey is required")
	}
	conn, err := s.dbWrite.Conn(ctx)
	if err != nil {
		return fmt.Errorf("get write conn: %w", err)
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, "BEGIN IMMEDIATE;"); err != nil {
		return fmt.Errorf("begin immediate: %w", err)
	}
	committed := false
	defer func() {
		if committed {
			return
		}
		_, _ = conn.ExecContext(ctx, "ROLLBACK;")
	}()

	now := time.Now().Unix()
	if _, err := conn.ExecContext(ctx, `
		INSERT INTO snapshots (dataset_generation_key, snapshot_blob, created_at)
		VALUES (?, ?, ?)
		ON CONFLICT(dataset_generation_key) DO UPDATE SET
			snapshot_blob = excluded.snapshot_blob,
			created_at = excluded.created_at
	`, snapshot.DatasetGenerationKey, snapshot.Blob, now); err != nil {
		return fmt.Errorf("insert snapshot: %w", err)
	}
	var datasetGenerationID int64
	row := conn.QueryRowContext(ctx, "SELECT dataset_generation_id FROM snapshots WHERE dataset_generation_key = ?", snapshot.DatasetGenerationKey)
	if err := row.Scan(&datasetGenerationID); err != nil {
		return fmt.Errorf("lookup snapshot id: %w", err)
	}
	if _, err := conn.ExecContext(ctx, `
		INSERT INTO meta (id, active_dataset_generation_id, updated_at)
		VALUES (1, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			active_dataset_generation_id = excluded.active_dataset_generation_id,
			updated_at = excluded.updated_at
	`, datasetGenerationID, now); err != nil {
		return fmt.Errorf("store snapshot: %w", err)
	}
	if _, err := conn.ExecContext(ctx, "DELETE FROM ops"); err != nil {
		return fmt.Errorf("clear ops: %w", err)
	}
	if _, err := conn.ExecContext(ctx, "DELETE FROM clients"); err != nil {
		return fmt.Errorf("clear clients: %w", err)
	}
	if _, err := conn.ExecContext(ctx, "COMMIT;"); err != nil {
		return fmt.Errorf("commit snapshot: %w", err)
	}
	committed = true
	return nil
}
