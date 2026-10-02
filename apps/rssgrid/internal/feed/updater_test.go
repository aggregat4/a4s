package feed

import (
	"context"
	"errors"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aggregat4/a4s/apps/rssgrid/internal/db"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestShouldBackOff(t *testing.T) {
	interval := 30 * time.Minute
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)

	tests := []struct {
		name     string
		feed     db.Feed
		expected bool
	}{
		{
			name:     "no failures never backs off",
			feed:     db.Feed{ConsecutiveFailures: 0},
			expected: false,
		},
		{
			name:     "few failures within grace threshold do not back off",
			feed:     db.Feed{ConsecutiveFailures: 3, LastErrorAt: now.Add(-interval)},
			expected: false,
		},
		{
			name:     "five failures retried too soon backs off",
			feed:     db.Feed{ConsecutiveFailures: 5, LastErrorAt: now.Add(-1 * time.Minute)},
			expected: true,
		},
		{
			name:     "five failures after backoff window elapses do not back off",
			feed:     db.Feed{ConsecutiveFailures: 5, LastErrorAt: now.Add(-17 * time.Hour)},
			expected: false,
		},
		{
			name:     "many failures cap backoff at 24h",
			feed:     db.Feed{ConsecutiveFailures: 50, LastErrorAt: now.Add(-23 * time.Hour)},
			expected: true,
		},
		{
			name:     "many failures past 24h window do not back off",
			feed:     db.Feed{ConsecutiveFailures: 50, LastErrorAt: now.Add(-25 * time.Hour)},
			expected: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.expected, shouldBackOff(tt.feed, now, interval))
		})
	}
}

// stubFetcher is a controllable FeedFetcher for updater tests.
type stubFetcher struct {
	content *FeedContent
	err     error
	calls   atomic.Int32
}

func (s *stubFetcher) FetchFeed(_ context.Context, _ string) (*FeedContent, error) {
	s.calls.Add(1)
	return s.content, s.err
}

func newUpdaterTestStore(t *testing.T) (*db.Store, func()) {
	t.Helper()
	tmp, err := createTempFile(t)
	require.NoError(t, err)
	store, err := db.NewStore(tmp)
	require.NoError(t, err)
	return store, func() {
		_ = store.Close()
		_ = removeFile(tmp)
	}
}

func createTempFile(t *testing.T) (string, error) {
	t.Helper()
	f, err := os.CreateTemp("", "updater-test-*.db")
	if err != nil {
		return "", err
	}
	name := f.Name()
	_ = f.Close()
	return name, nil
}

func removeFile(path string) error {
	return os.Remove(path)
}

func TestUpdateFeeds_RecordsFailureOnFetchError(t *testing.T) {
	store, cleanup := newUpdaterTestStore(t)
	t.Cleanup(cleanup)

	userID, err := store.GetOrCreateUser("sub", "iss")
	require.NoError(t, err)
	_, err = store.AddFeedForUser(userID, "https://example.com/feed.xml")
	require.NoError(t, err)

	fetchErr := errors.New("connection refused")
	updater := NewUpdaterWithFetcher(store, 30*time.Minute, 100, &stubFetcher{err: fetchErr})

	require.NoError(t, updater.updateFeeds(context.Background()))

	feeds, err := store.GetAllFeeds()
	require.NoError(t, err)
	require.Len(t, feeds, 1)
	assert.Equal(t, 1, feeds[0].ConsecutiveFailures)
	assert.Equal(t, "connection refused", feeds[0].LastError)
	assert.False(t, feeds[0].LastErrorAt.IsZero())
}

func TestUpdateFeeds_RecordsSuccessOnContent(t *testing.T) {
	store, cleanup := newUpdaterTestStore(t)
	t.Cleanup(cleanup)

	userID, err := store.GetOrCreateUser("sub", "iss")
	require.NoError(t, err)
	_, err = store.AddFeedForUser(userID, "https://example.com/feed.xml")
	require.NoError(t, err)

	content := &FeedContent{Title: "Test Feed"}
	updater := NewUpdaterWithFetcher(store, 30*time.Minute, 100, &stubFetcher{content: content})

	require.NoError(t, updater.updateFeeds(context.Background()))

	feeds, err := store.GetAllFeeds()
	require.NoError(t, err)
	require.Len(t, feeds, 1)
	assert.Equal(t, 0, feeds[0].ConsecutiveFailures)
	assert.Equal(t, "", feeds[0].LastError)
	assert.False(t, feeds[0].LastSuccessAt.IsZero(), "last_success_at should be set")

	// The feed title should have been updated from the fetched content.
	assert.Equal(t, "Test Feed", feeds[0].Title)
}

func TestUpdateFeeds_RecordsSuccessOnNotModified(t *testing.T) {
	store, cleanup := newUpdaterTestStore(t)
	t.Cleanup(cleanup)

	userID, err := store.GetOrCreateUser("sub", "iss")
	require.NoError(t, err)
	_, err = store.AddFeedForUser(userID, "https://example.com/feed.xml")
	require.NoError(t, err)

	// stubFetcher returns nil content and nil error, mirroring a 304 Not Modified.
	updater := NewUpdaterWithFetcher(store, 30*time.Minute, 100, &stubFetcher{content: nil})

	require.NoError(t, updater.updateFeeds(context.Background()))

	feeds, err := store.GetAllFeeds()
	require.NoError(t, err)
	require.Len(t, feeds, 1)
	assert.Equal(t, 0, feeds[0].ConsecutiveFailures)
	assert.False(t, feeds[0].LastSuccessAt.IsZero(), "last_success_at should be set even on 304")
}

func TestUpdateFeeds_SkipsFeedUnderBackoff(t *testing.T) {
	store, cleanup := newUpdaterTestStore(t)
	t.Cleanup(cleanup)

	userID, err := store.GetOrCreateUser("sub", "iss")
	require.NoError(t, err)
	_, err = store.AddFeedForUser(userID, "https://example.com/feed.xml")
	require.NoError(t, err)

	feeds, err := store.GetAllFeeds()
	require.NoError(t, err)
	require.Len(t, feeds, 1)
	feedID := feeds[0].ID

	// Seed enough recent failures to trigger backoff.
	for i := 0; i < 5; i++ {
		require.NoError(t, store.RecordFeedFailure(feedID, errors.New("boom"), time.Now()))
	}

	stub := &stubFetcher{content: &FeedContent{Title: "Should Not Be Called"}}
	updater := NewUpdaterWithFetcher(store, 30*time.Minute, 100, stub)

	require.NoError(t, updater.updateFeeds(context.Background()))

	assert.Equal(t, int32(0), stub.calls.Load(), "fetcher must not be called for a feed under backoff")

	// Failure state is unchanged by the skipped cycle.
	feeds, err = store.GetAllFeeds()
	require.NoError(t, err)
	require.Len(t, feeds, 1)
	assert.Equal(t, 5, feeds[0].ConsecutiveFailures)
}

func addTestFeed(t *testing.T, store *db.Store) db.Feed {
	t.Helper()
	userID, err := store.GetOrCreateUser("sub", "iss")
	require.NoError(t, err)
	_, err = store.AddFeedForUser(userID, "https://example.com/feed.xml")
	require.NoError(t, err)
	feeds, err := store.GetAllFeeds()
	require.NoError(t, err)
	require.Len(t, feeds, 1)
	return feeds[0]
}

func TestUpdateFeeds_EmptyTitleDoesNotOverwrite(t *testing.T) {
	store, cleanup := newUpdaterTestStore(t)
	t.Cleanup(cleanup)
	f := addTestFeed(t, store)
	require.NoError(t, store.UpdateFeedTitle(f.ID, "Original"))

	updater := NewUpdaterWithFetcher(store, 30*time.Minute, 100, &stubFetcher{content: &FeedContent{Title: ""}})
	require.NoError(t, updater.updateFeeds(context.Background()))

	feeds, err := store.GetAllFeeds()
	require.NoError(t, err)
	assert.Equal(t, "Original", feeds[0].Title)
}

func TestIngestContent_CountsOnlyNewPosts(t *testing.T) {
	store, cleanup := newUpdaterTestStore(t)
	t.Cleanup(cleanup)
	f := addTestFeed(t, store)

	content := &FeedContent{Items: []FeedItem{
		{GUID: "1", Title: "One", Link: "https://example.com/1", PublishedAt: time.Now()},
		{GUID: "2", Title: "Two", Link: "https://example.com/2", PublishedAt: time.Now()},
	}}
	assert.Equal(t, 2, IngestContent(store, f.ID, f.Title, content))
	assert.Equal(t, 0, IngestContent(store, f.ID, f.Title, content))
	assert.Equal(t, 0, IngestContent(store, f.ID, f.Title, nil))
}

func TestUpdater_StartRunsImmediatelyAndStopWaits(t *testing.T) {
	store, cleanup := newUpdaterTestStore(t)
	t.Cleanup(cleanup)
	addTestFeed(t, store)

	stub := &stubFetcher{content: nil}
	updater := NewUpdaterWithFetcher(store, time.Hour, 100, stub)
	updater.Start(context.Background())

	require.Eventually(t, func() bool { return stub.calls.Load() > 0 }, 5*time.Second, 10*time.Millisecond,
		"the first update cycle must run at startup, not after one interval")

	done := make(chan struct{})
	go func() {
		updater.Stop()
		updater.Stop() // idempotent
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Stop did not return")
	}
}

func TestUpdater_StopAfterParentContextCancelled(t *testing.T) {
	store, cleanup := newUpdaterTestStore(t)
	t.Cleanup(cleanup)

	updater := NewUpdaterWithFetcher(store, time.Hour, 100, &stubFetcher{})
	ctx, cancel := context.WithCancel(context.Background())
	updater.Start(ctx)
	cancel()

	done := make(chan struct{})
	go func() {
		updater.Stop()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Stop blocked after the parent context was cancelled")
	}
}

func TestUpdateFeeds_SkipsFreshCacheWithoutRecordingAFetch(t *testing.T) {
	store, cleanup := newUpdaterTestStore(t)
	t.Cleanup(cleanup)
	f := addTestFeed(t, store)
	require.NoError(t, store.UpdateFeedCacheInfo(f.ID, "", "", time.Now().Add(time.Hour)))

	stub := &stubFetcher{content: &FeedContent{Title: "Should Not Be Called"}}
	updater := NewUpdaterWithFetcher(store, 30*time.Minute, 100, stub)
	require.NoError(t, updater.updateFeeds(context.Background()))

	assert.Equal(t, int32(0), stub.calls.Load(), "fetcher must not be called while the cache is fresh")
	feeds, err := store.GetAllFeeds()
	require.NoError(t, err)
	assert.True(t, feeds[0].LastFetchedAt.IsZero(), "a skipped feed must not update last_fetched_at")
	assert.True(t, feeds[0].LastSuccessAt.IsZero(), "a skipped feed must not record a success")
}

func TestUpdateFeeds_FetchesWhenCacheExpired(t *testing.T) {
	store, cleanup := newUpdaterTestStore(t)
	t.Cleanup(cleanup)
	f := addTestFeed(t, store)
	require.NoError(t, store.UpdateFeedCacheInfo(f.ID, "", "", time.Now().Add(-time.Minute)))

	stub := &stubFetcher{content: nil}
	updater := NewUpdaterWithFetcher(store, 30*time.Minute, 100, stub)
	require.NoError(t, updater.updateFeeds(context.Background()))

	assert.Equal(t, int32(1), stub.calls.Load())
	feeds, err := store.GetAllFeeds()
	require.NoError(t, err)
	assert.False(t, feeds[0].LastFetchedAt.IsZero())
}

// When a feed document carries more items than maxPostsPerFeed, the items
// still present in the feed must not be pruned, otherwise they come back as
// new unread posts on every cycle.
func TestUpdateFeeds_PruningDoesNotResurrectPostsAsUnread(t *testing.T) {
	store, cleanup := newUpdaterTestStore(t)
	t.Cleanup(cleanup)

	userID, err := store.GetOrCreateUser("sub", "iss")
	require.NoError(t, err)
	feedID, err := store.AddFeedForUser(userID, "https://example.com/feed.xml")
	require.NoError(t, err)

	base := time.Now().Add(-24 * time.Hour)
	content := &FeedContent{Title: "Big Feed"}
	for i := 0; i < 5; i++ {
		content.Items = append(content.Items, FeedItem{
			GUID:        string(rune('a' + i)),
			Title:       "Post",
			Link:        "https://example.com/p",
			PublishedAt: base.Add(time.Duration(i) * time.Hour),
		})
	}

	updater := NewUpdaterWithFetcher(store, 30*time.Minute, 2, &stubFetcher{content: content})
	require.NoError(t, updater.updateFeeds(context.Background()))
	require.NoError(t, store.MarkAllFeedPostsAsSeenForUser(userID, feedID))

	require.NoError(t, updater.updateFeeds(context.Background()))

	posts, err := store.GetFeedPosts(feedID, userID, 100)
	require.NoError(t, err)
	assert.Len(t, posts, 5, "items still in the feed must be kept")
	for _, p := range posts {
		assert.True(t, p.Seen, "post %d must stay seen", p.ID)
	}
}

func TestUpdateFeeds_PrunesItemsNoLongerInFeed(t *testing.T) {
	store, cleanup := newUpdaterTestStore(t)
	t.Cleanup(cleanup)

	userID, err := store.GetOrCreateUser("sub", "iss")
	require.NoError(t, err)
	feedID, err := store.AddFeedForUser(userID, "https://example.com/feed.xml")
	require.NoError(t, err)

	base := time.Now().Add(-24 * time.Hour)
	for i := 0; i < 5; i++ {
		require.NoError(t, store.AddPost(feedID, "old-"+string(rune('a'+i)), "Old", "https://example.com/o", base.Add(time.Duration(i)*time.Minute), ""))
	}
	content := &FeedContent{Items: []FeedItem{
		{GUID: "new", Title: "New", Link: "https://example.com/n", PublishedAt: time.Now()},
	}}

	updater := NewUpdaterWithFetcher(store, 30*time.Minute, 2, &stubFetcher{content: content})
	require.NoError(t, updater.updateFeeds(context.Background()))

	posts, err := store.GetFeedPosts(feedID, userID, 100)
	require.NoError(t, err)
	assert.Len(t, posts, 2)
}
