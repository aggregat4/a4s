package feed

import (
	"context"
	"errors"
	"log/slog"
	"math"
	"sync"
	"time"

	"github.com/aggregat4/a4s/apps/rssgrid/internal/db"
)

// FeedFetcher abstracts fetching a single feed by URL, so the updater can be
// tested without hitting the network. *Fetcher satisfies it.
type FeedFetcher interface {
	FetchFeed(ctx context.Context, url string, validators Validators) (*FetchResult, error)
}

// backoffThreshold is the number of consecutive failures after which the
// updater starts backing off before retrying a feed.
const backoffThreshold = 5

// fetchConcurrency is the number of feeds fetched in parallel per cycle.
const fetchConcurrency = 4

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
	return NewUpdaterWithFetcher(store, interval, maxPostsPerFeed, NewFetcher())
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
				slog.Error("Error updating feeds", "err", err)
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
	slog.Info("Starting feed update cycle")

	feeds, err := u.store.GetAllFeeds()
	if err != nil {
		return err
	}

	slog.Info("Found feeds to update", "count", len(feeds))

	// Fetch up to fetchConcurrency feeds at a time so that a few slow or
	// timing-out feeds do not hold up the whole cycle.
	sem := make(chan struct{}, fetchConcurrency)
	var wg sync.WaitGroup
	for _, feed := range feeds {
		select {
		case sem <- struct{}{}:
		case <-ctx.Done():
		}
		if ctx.Err() != nil {
			break
		}
		wg.Go(func() {
			defer func() { <-sem }()
			u.updateFeed(ctx, feed, time.Now())
		})
	}
	wg.Wait()
	if err := ctx.Err(); err != nil {
		return err
	}

	slog.Info("Feed update cycle completed")
	return nil
}

// updateFeed fetches a single feed if it is due and records the outcome.
func (u *Updater) updateFeed(ctx context.Context, feed db.Feed, now time.Time) {
	if shouldBackOff(feed, now, u.interval) {
		slog.Info("Skipping feed: backing off after consecutive failures",
			"url", feed.URL, "failures", feed.ConsecutiveFailures)
		return
	}
	if cacheFresh(feed, now) {
		// Not fetched at all, so neither success nor last-fetched is recorded.
		slog.Debug("Skipping feed: cache still fresh", "url", feed.URL, "cacheUntil", feed.CacheUntil)
		return
	}

	slog.Debug("Updating feed", "url", feed.URL)

	result, err := u.fetcher.FetchFeed(ctx, feed.URL, Validators{ETag: feed.ETag, LastModified: feed.LastModified})
	if err != nil {
		if ctx.Err() != nil {
			// Shutting down; the feed itself is not at fault.
			return
		}
		slog.Warn("Error fetching feed", "url", feed.URL, "err", err)
		if recordErr := u.store.RecordFeedFailure(feed.ID, err, time.Now()); recordErr != nil {
			slog.Error("Error recording feed failure", "url", feed.URL, "err", recordErr)
		}
		return
	}

	// A completed fetch (new content or 304 Not Modified) clears the failure
	// state and records the success time.
	fetchedAt := time.Now()
	if recordErr := u.store.RecordFeedSuccess(feed.ID, fetchedAt); recordErr != nil {
		slog.Error("Error recording feed success", "url", feed.URL, "err", recordErr)
	}
	if err := u.store.UpdateFeedLastFetched(feed.ID, fetchedAt); err != nil {
		slog.Error("Error updating feed last fetched", "url", feed.URL, "err", err)
	}

	if result.NotModified() {
		slog.Debug("Feed not modified", "url", feed.URL)
		return
	}
	content := result.Content

	if err := u.store.UpdateFeedCacheInfo(feed.ID, result.Cache.ETag, result.Cache.LastModified, result.Cache.CacheUntil); err != nil {
		slog.Error("Error updating cache info", "url", feed.URL, "err", err)
	}

	if n := IngestContent(u.store, feed.ID, feed.Title, content); n > 0 {
		slog.Info("Added new posts", "url", feed.URL, "count", n)
	}

	// Prune old posts to prevent unbounded database growth. Items still in
	// the feed document are kept so they are not re-inserted as unread on
	// the next fetch.
	if err := u.store.PruneFeedPosts(feed.ID, u.maxPostsPerFeed, content.GUIDs()...); err != nil {
		slog.Error("Error pruning posts", "url", feed.URL, "err", err)
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
