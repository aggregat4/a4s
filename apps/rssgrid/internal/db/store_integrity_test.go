package db

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func tempDBPath(t *testing.T) string {
	t.Helper()
	f, err := os.CreateTemp("", "integrity-test-*.db")
	require.NoError(t, err)
	require.NoError(t, f.Close())
	t.Cleanup(func() {
		_ = os.Remove(f.Name())
		_ = os.Remove(f.Name() + "-wal")
		_ = os.Remove(f.Name() + "-shm")
	})
	return f.Name()
}

// Foreign keys must be enforced on every pooled connection, including after
// a restart when the first migration (which used to set the PRAGMA) does not
// run again.
func TestForeignKeysEnforcedAfterReopen(t *testing.T) {
	path := tempDBPath(t)

	store, err := NewStore(path)
	require.NoError(t, err)
	require.NoError(t, store.Close())

	store, err = NewStore(path)
	require.NoError(t, err)
	t.Cleanup(func() { _ = store.Close() })

	// Check several concurrently held connections.
	ctx := context.Background()
	for i := 0; i < 3; i++ {
		conn, err := store.db.Conn(ctx)
		require.NoError(t, err)
		defer conn.Close()
		var fk int
		require.NoError(t, conn.QueryRowContext(ctx, "PRAGMA foreign_keys").Scan(&fk))
		assert.Equal(t, 1, fk, "connection %d must enforce foreign keys", i)
	}

	userID, err := store.GetOrCreateUser("sub", "iss")
	require.NoError(t, err)
	feedID, err := store.AddFeedForUser(userID, "https://example.com/feed.xml")
	require.NoError(t, err)
	require.NoError(t, store.AddPost(feedID, "g", "t", "https://example.com/p", time.Now(), "c"))
	posts, err := store.GetFeedPosts(feedID, userID, 10)
	require.NoError(t, err)
	require.Len(t, posts, 1)
	require.NoError(t, store.MarkPostAsSeenForUser(userID, posts[0].ID))

	require.NoError(t, store.DeleteFeedForUser(userID, feedID))

	var n int
	require.NoError(t, store.db.QueryRow("SELECT COUNT(*) FROM posts").Scan(&n))
	assert.Equal(t, 0, n, "posts must cascade-delete with their feed")
	require.NoError(t, store.db.QueryRow("SELECT COUNT(*) FROM user_post_states").Scan(&n))
	assert.Equal(t, 0, n, "read states must cascade-delete with their posts")
}

func TestMigrationRemovesOrphanedRows(t *testing.T) {
	path := tempDBPath(t)

	store, err := NewStore(path)
	require.NoError(t, err)
	userID, err := store.GetOrCreateUser("sub", "iss")
	require.NoError(t, err)

	// Simulate rows left behind while foreign keys were not enforced.
	ctx := context.Background()
	conn, err := store.db.Conn(ctx)
	require.NoError(t, err)
	_, err = conn.ExecContext(ctx, "PRAGMA foreign_keys = OFF")
	require.NoError(t, err)
	_, err = conn.ExecContext(ctx, "INSERT INTO posts (id, feed_id, guid, link) VALUES (500, 999, 'orphan', 'https://example.com/o')")
	require.NoError(t, err)
	_, err = conn.ExecContext(ctx, "INSERT INTO user_post_states (user_id, post_id, seen) VALUES (?, 500, 1)", userID)
	require.NoError(t, err)
	_, err = conn.ExecContext(ctx, "INSERT INTO user_feeds (user_id, feed_id) VALUES (?, 999)", userID)
	require.NoError(t, err)
	_, err = conn.ExecContext(ctx, "DELETE FROM migrations WHERE sequence_id = 5")
	require.NoError(t, err)
	require.NoError(t, conn.Close())
	require.NoError(t, store.Close())

	store, err = NewStore(path)
	require.NoError(t, err)
	t.Cleanup(func() { _ = store.Close() })

	for _, table := range []string{"posts", "user_post_states", "user_feeds"} {
		var n int
		require.NoError(t, store.db.QueryRow("SELECT COUNT(*) FROM "+table).Scan(&n))
		assert.Equal(t, 0, n, "orphaned rows in %s must be removed", table)
	}
}

func TestSetUserPreferences(t *testing.T) {
	store, err := NewStore(tempDBPath(t))
	require.NoError(t, err)
	t.Cleanup(func() { _ = store.Close() })

	userID, err := store.GetOrCreateUser("sub", "iss")
	require.NoError(t, err)

	require.NoError(t, store.SetUserPreferences(userID, 20, 4))
	require.NoError(t, store.SetUserPreferences(userID, 25, 3))

	posts, err := store.GetUserPostsPerFeed(userID)
	require.NoError(t, err)
	cols, err := store.GetUserColumns(userID)
	require.NoError(t, err)
	assert.Equal(t, 25, posts)
	assert.Equal(t, 3, cols)
}

func TestInsertPostReportsWhetherNew(t *testing.T) {
	store, err := NewStore(tempDBPath(t))
	require.NoError(t, err)
	t.Cleanup(func() { _ = store.Close() })

	userID, err := store.GetOrCreateUser("sub", "iss")
	require.NoError(t, err)
	feedID, err := store.AddFeedForUser(userID, "https://example.com/feed.xml")
	require.NoError(t, err)

	inserted, err := store.InsertPost(feedID, "g", "t", "https://example.com/p", time.Now(), "")
	require.NoError(t, err)
	assert.True(t, inserted)
	inserted, err = store.InsertPost(feedID, "g", "t", "https://example.com/p", time.Now(), "")
	require.NoError(t, err)
	assert.False(t, inserted)
}

func TestPruneFeedPostsKeepsProtectedGUIDs(t *testing.T) {
	store, err := NewStore(tempDBPath(t))
	require.NoError(t, err)
	t.Cleanup(func() { _ = store.Close() })

	userID, err := store.GetOrCreateUser("sub", "iss")
	require.NoError(t, err)
	feedID, err := store.AddFeedForUser(userID, "https://example.com/feed.xml")
	require.NoError(t, err)

	base := time.Now()
	for i, guid := range []string{"oldest", "older", "newer", "newest"} {
		require.NoError(t, store.AddPost(feedID, guid, guid, "https://example.com/"+guid, base.Add(time.Duration(i)*time.Hour), ""))
	}

	require.NoError(t, store.PruneFeedPosts(feedID, 2, "oldest"))

	rows, err := store.db.Query("SELECT guid FROM posts WHERE feed_id = ? ORDER BY guid", feedID)
	require.NoError(t, err)
	defer rows.Close()
	var guids []string
	for rows.Next() {
		var g string
		require.NoError(t, rows.Scan(&g))
		guids = append(guids, g)
	}
	assert.Equal(t, []string{"newer", "newest", "oldest"}, guids)
}
