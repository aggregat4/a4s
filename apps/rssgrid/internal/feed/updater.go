package feed

import (
	"context"
	"errors"
	"log"
	"math"
	"sync"
	"time"

	"github.com/aggregat4/a4s/apps/rssgrid/internal/db"
)

// FeedFetcher abstracts fetching a single feed by URL, so the updater can be
// tested without hitting the network. *Fetcher satisfies it.
type FeedFetcher interface {
	FetchFeed(ctx context.Context, url string) (*FeedContent, error)
}

// backoffThreshold is the number of consecutive failures after which the
// updater starts backing off before retrying a feed.
const backoffThreshold = 5

// maxBackoff caps the exponential backoff window applied to failing feeds.
const maxBackoff = 24 * time.Hour

type Updater struct {
	store           *db.Store
	fetcher         FeedFetcher
	interval        time.Duration
	maxPostsPerFeed int

	cancel context.CancelFunc
	wg     sync.WaitGroup
}

func NewUpdater(store *db.Store, interval time.Duration, maxPostsPerFeed int) *Updater {
	return NewUpdaterWithFetcher(store, interval, maxPostsPerFeed, NewFetcher(store))
}

// NewUpdaterWithFetcher constructs an Updater that uses the given fetcher,
// primarily for tests. Nothing runs until Start is called.
func NewUpdaterWithFetcher(store *db.Store, interval time.Duration, maxPostsPerFeed int, fetcher FeedFetcher) *Updater {
	return &Updater{
		store:           store,
		fetcher:         fetcher,
		interval:        interval,
		maxPostsPerFeed: maxPostsPerFeed,
	}
}

// Start runs an update cycle immediately and then once per interval until ctx
// is cancelled or Stop is called.
func (u *Updater) Start(ctx context.Context) {
	ctx, u.cancel = context.WithCancel(ctx)
	u.wg.Add(1)
	go func() {
		defer u.wg.Done()
		ticker := time.NewTicker(u.interval)
		defer ticker.Stop()
		for {
			if err := u.updateFeeds(ctx); err != nil && !errors.Is(err, context.Canceled) {
				log.Printf("Error updating feeds: %v", err)
			}
			select {
			case <-ticker.C:
			case <-ctx.Done():
				return
			}
		}
	}()
}

// Stop cancels the updater and waits for an in-flight update cycle to finish,
// so the store can be closed safely afterwards. It is safe to call more than
// once and after the parent context has been cancelled.
func (u *Updater) Stop() {
	if u.cancel != nil {
		u.cancel()
	}
	u.wg.Wait()
}

func (u *Updater) updateFeeds(ctx context.Context) error {
	log.Printf("Starting feed update cycle")

	feeds, err := u.store.GetAllFeeds()
	if err != nil {
		return err
	}

	log.Printf("Found %d feeds to update", len(feeds))

	for _, feed := range feeds {
		if err := ctx.Err(); err != nil {
			return err
		}
		u.updateFeed(ctx, feed, time.Now())
	}

	log.Printf("Feed update cycle completed")
	return nil
}

// updateFeed fetches a single feed if it is due and records the outcome.
func (u *Updater) updateFeed(ctx context.Context, feed db.Feed, now time.Time) {
	if shouldBackOff(feed, now, u.interval) {
		log.Printf("Skipping feed %s (%s): backing off after %d consecutive failures",
			feed.Title, feed.URL, feed.ConsecutiveFailures)
		return
	}
	if cacheFresh(feed, now) {
		// Not fetched at all, so neither success nor last-fetched is recorded.
		log.Printf("Skipping feed %s (%s): cached until %s", feed.Title, feed.URL, feed.CacheUntil.Format(time.RFC3339))
		return
	}

	log.Printf("Updating feed: %s (%s)", feed.Title, feed.URL)

	content, err := u.fetcher.FetchFeed(ctx, feed.URL)
	if err != nil {
		if ctx.Err() != nil {
			// Shutting down; the feed itself is not at fault.
			return
		}
		log.Printf("Error fetching feed %s: %v", feed.URL, err)
		if recordErr := u.store.RecordFeedFailure(feed.ID, err, time.Now()); recordErr != nil {
			log.Printf("Error recording feed failure for %s: %v", feed.URL, recordErr)
		}
		return
	}

	// A completed fetch (new content or 304 Not Modified) clears the failure
	// state and records the success time.
	fetchedAt := time.Now()
	if recordErr := u.store.RecordFeedSuccess(feed.ID, fetchedAt); recordErr != nil {
		log.Printf("Error recording feed success for %s: %v", feed.URL, recordErr)
	}
	if err := u.store.UpdateFeedLastFetched(feed.ID, fetchedAt); err != nil {
		log.Printf("Error updating feed last fetched: %v", err)
	}

	if content == nil {
		log.Printf("Feed %s not modified", feed.URL)
		return
	}

	if n := IngestContent(u.store, feed.ID, feed.Title, content); n > 0 {
		log.Printf("Added %d new posts from feed: %s", n, feed.URL)
	}

	// Prune old posts to prevent unbounded database growth. Items still in
	// the feed document are kept so they are not re-inserted as unread on
	// the next fetch.
	if err := u.store.PruneFeedPosts(feed.ID, u.maxPostsPerFeed, content.GUIDs()...); err != nil {
		log.Printf("Error pruning posts for feed %s: %v", feed.URL, err)
	}
}

// cacheFresh reports whether the feed's HTTP cache lifetime has not yet expired,
// in which case it does not need to be fetched this cycle.
func cacheFresh(feed db.Feed, now time.Time) bool {
	return !feed.CacheUntil.IsZero() && now.Before(feed.CacheUntil)
}

// shouldBackOff reports whether a feed should be skipped this cycle because it
// has been failing repeatedly and the exponential backoff window has not yet
// elapsed. The backoff is 2^(failures) * interval, capped at maxBackoff, and
// only applies once ConsecutiveFailures reaches backoffThreshold.
func shouldBackOff(feed db.Feed, now time.Time, interval time.Duration) bool {
	if feed.ConsecutiveFailures < backoffThreshold {
		return false
	}
	if feed.LastErrorAt.IsZero() {
		return false
	}
	backoff := time.Duration(math.Pow(2, float64(feed.ConsecutiveFailures))) * interval
	if backoff > maxBackoff {
		backoff = maxBackoff
	}
	return now.Before(feed.LastErrorAt.Add(backoff))
}
