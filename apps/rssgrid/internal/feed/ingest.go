package feed

import (
	"log/slog"
	"time"
)

// ContentStore is the subset of the store needed to ingest fetched content.
type ContentStore interface {
	UpdateFeedTitle(feedID int64, title string) error
	InsertPost(feedID int64, guid, title, link string, publishedAt time.Time, content string) (bool, error)
}

// IngestContent stores fetched feed content: it updates the feed title when the
// feed provides a new non-empty one and inserts posts that are not stored yet.
// It returns the number of newly inserted posts. Errors are logged per item so
// that one bad item does not prevent the rest from being stored.
func IngestContent(store ContentStore, feedID int64, currentTitle string, content *FeedContent) int {
	if content == nil {
		return 0
	}

	if content.Title != "" && content.Title != currentTitle {
		if err := store.UpdateFeedTitle(feedID, content.Title); err != nil {
			slog.Error("Error updating feed title", "feedId", feedID, "err", err)
		}
	}

	newPosts := 0
	for _, item := range content.Items {
		inserted, err := store.InsertPost(feedID, item.GUID, item.Title, item.Link, item.PublishedAt, item.Content)
		if err != nil {
			slog.Error("Error adding post", "feedId", feedID, "guid", item.GUID, "err", err)
			continue
		}
		if inserted {
			newPosts++
		}
	}
	return newPosts
}

// GUIDs returns the GUIDs of all items in the content.
func (c *FeedContent) GUIDs() []string {
	if c == nil {
		return nil
	}
	guids := make([]string, 0, len(c.Items))
	for _, item := range c.Items {
		guids = append(guids, item.GUID)
	}
	return guids
}
