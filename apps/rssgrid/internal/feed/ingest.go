package feed

import (
	"log"
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
			log.Printf("Error updating title of feed %d: %v", feedID, err)
		}
	}

	newPosts := 0
	for _, item := range content.Items {
		inserted, err := store.InsertPost(feedID, item.GUID, item.Title, item.Link, item.PublishedAt, item.Content)
		if err != nil {
			log.Printf("Error adding post %q to feed %d: %v", item.GUID, feedID, err)
			continue
		}
		if inserted {
			newPosts++
		}
	}
	return newPosts
}
