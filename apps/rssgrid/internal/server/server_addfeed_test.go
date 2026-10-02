package server

import (
	"context"
	"testing"
	"time"

	"github.com/aggregat4/a4s/apps/rssgrid/internal/feed"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type stubFetcher struct {
	content *feed.FeedContent
	err     error
}

func (s *stubFetcher) FetchFeed(_ context.Context, _ string) (*feed.FeedContent, error) {
	return s.content, s.err
}

// A feed that is already known can come back as 304 Not Modified, in which
// case the fetcher returns no content. Adding it must subscribe the user
// instead of panicking.
func TestAddFeed_NotModifiedSubscribesUser(t *testing.T) {
	store, cleanup := createTestStore(t)
	defer cleanup()

	owner, err := store.GetOrCreateUser("owner", "iss")
	require.NoError(t, err)
	other, err := store.GetOrCreateUser("other", "iss")
	require.NoError(t, err)
	_, err = store.AddFeedForUser(owner, "https://example.com/feed.xml")
	require.NoError(t, err)

	server := createTestServerWithStore(t, store)
	server.fetcher = &stubFetcher{content: nil}

	req, w := postForm(t, server, "/settings/feeds", "url=https://example.com/feed.xml", other)
	require.NotPanics(t, func() { server.handleAddFeed(w, req) })
	assertRedirect(t, w, "/settings")

	feeds, err := store.GetUserFeeds(other)
	require.NoError(t, err)
	require.Len(t, feeds, 1)
	assert.Equal(t, "https://example.com/feed.xml", feeds[0].URL)
}

func TestAddFeed_IngestsContent(t *testing.T) {
	store, cleanup := createTestStore(t)
	defer cleanup()

	userID, err := store.GetOrCreateUser("user", "iss")
	require.NoError(t, err)

	server := createTestServerWithStore(t, store)
	server.fetcher = &stubFetcher{content: &feed.FeedContent{
		Title: "Example",
		Items: []feed.FeedItem{
			{GUID: "a", Title: "A", Link: "https://example.com/a", PublishedAt: time.Now()},
			{GUID: "b", Title: "B", Link: "https://example.com/b", PublishedAt: time.Now()},
		},
	}}

	req, w := postForm(t, server, "/settings/feeds", "url=https://example.com/feed.xml", userID)
	server.handleAddFeed(w, req)
	assertRedirect(t, w, "/settings")

	feeds, err := store.GetUserFeeds(userID)
	require.NoError(t, err)
	require.Len(t, feeds, 1)
	assert.Equal(t, "Example", feeds[0].Title)

	posts, err := store.GetFeedPosts(feeds[0].ID, userID, 10)
	require.NoError(t, err)
	assert.Len(t, posts, 2)
}
