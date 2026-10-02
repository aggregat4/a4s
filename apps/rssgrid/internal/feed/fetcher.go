package feed

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/mmcdole/gofeed"
)

// Fetcher downloads and parses feeds over HTTP. It holds no state about
// stored feeds: callers pass the validators for conditional requests and
// persist the returned cache information themselves.
type Fetcher struct {
	client *http.Client
	parser *gofeed.Parser
}

func NewFetcher() *Fetcher {
	return &Fetcher{
		client: &http.Client{
			Timeout: 30 * time.Second,
		},
		parser: gofeed.NewParser(),
	}
}

type FeedContent struct {
	Title       string
	Items       []FeedItem
	LastUpdated time.Time
}

type FeedItem struct {
	GUID        string
	Title       string
	Link        string
	PublishedAt time.Time
	Content     string
}

// Validators are the values from a previous response used to make a
// conditional request. The zero value makes an unconditional request.
type Validators struct {
	ETag         string
	LastModified string
}

// CacheInfo is the HTTP caching information of a successful response.
type CacheInfo struct {
	ETag         string
	LastModified string
	CacheUntil   time.Time
}

// FetchResult is the outcome of a completed fetch. Content is nil when the
// server answered 304 Not Modified, in which case Cache is not set.
type FetchResult struct {
	Content *FeedContent
	Cache   CacheInfo
}

// NotModified reports whether the server answered 304 Not Modified.
func (r *FetchResult) NotModified() bool {
	return r.Content == nil
}

// FetchFeed fetches and parses the feed at url, sending the given validators
// as If-None-Match / If-Modified-Since headers when they are set.
func (f *Fetcher) FetchFeed(ctx context.Context, url string, validators Validators) (*FetchResult, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, fmt.Errorf("error creating request: %w", err)
	}

	req.Header.Set("User-Agent", "RSSGrid/1.0")
	req.Header.Set("Accept", "application/rss+xml, application/atom+xml, application/json")
	if validators.ETag != "" {
		req.Header.Set("If-None-Match", validators.ETag)
	}
	if validators.LastModified != "" {
		req.Header.Set("If-Modified-Since", validators.LastModified)
	}

	resp, err := f.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("error fetching feed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotModified {
		return &FetchResult{}, nil
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("feed returned non-200 status code: %d", resp.StatusCode)
	}

	feedContent, err := f.parser.Parse(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("error parsing feed: %w", err)
	}

	content := &FeedContent{
		Title: feedContent.Title,
		Items: make([]FeedItem, 0, len(feedContent.Items)),
	}

	if feedContent.UpdatedParsed != nil {
		content.LastUpdated = *feedContent.UpdatedParsed
	} else if feedContent.PublishedParsed != nil {
		content.LastUpdated = *feedContent.PublishedParsed
	}

	for _, item := range feedContent.Items {
		// Determine GUID
		guid := item.GUID
		if guid == "" {
			guid = item.Link
		}

		// Determine published time
		publishedAt := time.Now()
		if item.PublishedParsed != nil {
			publishedAt = *item.PublishedParsed
		} else if item.UpdatedParsed != nil {
			publishedAt = *item.UpdatedParsed
		}

		// Get content
		postContent := item.Content
		if postContent == "" {
			postContent = item.Description
		}

		content.Items = append(content.Items, FeedItem{
			GUID:        guid,
			Title:       item.Title,
			Link:        item.Link,
			PublishedAt: publishedAt,
			Content:     postContent,
		})
	}

	return &FetchResult{
		Content: content,
		Cache:   f.extractCacheInfo(resp.Header),
	}, nil
}

func (f *Fetcher) extractCacheInfo(headers http.Header) CacheInfo {
	info := CacheInfo{
		CacheUntil: time.Now().Add(1 * time.Hour), // Default to 1 hour
	}

	// Extract ETag
	if etag := headers.Get("ETag"); etag != "" {
		info.ETag = etag
	}

	// Extract Last-Modified
	if lastModified := headers.Get("Last-Modified"); lastModified != "" {
		info.LastModified = lastModified
	}

	// Cache-Control max-age takes precedence over Expires (RFC 9111 5.3)
	if maxAge := f.parseMaxAge(headers.Get("Cache-Control")); maxAge > 0 {
		info.CacheUntil = time.Now().Add(time.Duration(maxAge) * time.Second)
	} else if expires := headers.Get("Expires"); expires != "" {
		if parsedTime, err := http.ParseTime(expires); err == nil {
			info.CacheUntil = parsedTime
		}
	}

	return info
}

func (f *Fetcher) parseMaxAge(cacheControl string) int {
	parts := strings.Split(cacheControl, ",")
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if strings.HasPrefix(part, "max-age=") {
			if maxAgeStr := strings.TrimPrefix(part, "max-age="); maxAgeStr != "" {
				if maxAge, err := strconv.Atoi(maxAgeStr); err == nil {
					return maxAge
				}
			}
		}
	}
	return 0
}
