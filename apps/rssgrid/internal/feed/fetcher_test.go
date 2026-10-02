package feed

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestFetcher_ExtractCacheInfo(t *testing.T) {
	fetcher := &Fetcher{}

	// Test ETag extraction
	headers := http.Header{}
	headers.Set("ETag", `"abc123"`)
	headers.Set("Last-Modified", "Wed, 21 Oct 2015 07:28:00 GMT")
	headers.Set("Cache-Control", "max-age=3600")

	cacheInfo := fetcher.extractCacheInfo(headers)

	if cacheInfo.ETag != `"abc123"` {
		t.Errorf("Expected ETag to be \"abc123\", got %s", cacheInfo.ETag)
	}

	if cacheInfo.LastModified != "Wed, 21 Oct 2015 07:28:00 GMT" {
		t.Errorf("Expected Last-Modified to be \"Wed, 21 Oct 2015 07:28:00 GMT\", got %s", cacheInfo.LastModified)
	}

	// Check that cache_until is set to a future time (within reasonable bounds)
	expectedMin := time.Now().Add(3599 * time.Second) // 1 hour - 1 second
	expectedMax := time.Now().Add(3601 * time.Second) // 1 hour + 1 second
	if cacheInfo.CacheUntil.Before(expectedMin) || cacheInfo.CacheUntil.After(expectedMax) {
		t.Errorf("Expected CacheUntil to be around 1 hour from now, got %v", cacheInfo.CacheUntil)
	}
}

func TestFetcher_ParseMaxAge(t *testing.T) {
	fetcher := &Fetcher{}

	tests := []struct {
		input    string
		expected int
	}{
		{"max-age=3600", 3600},
		{"public, max-age=1800", 1800},
		{"no-cache", 0},
		{"max-age=invalid", 0},
		{"", 0},
	}

	for _, test := range tests {
		result := fetcher.parseMaxAge(test.input)
		if result != test.expected {
			t.Errorf("parseMaxAge(%q) = %d, expected %d", test.input, result, test.expected)
		}
	}
}

func TestFetcher_ExtractCacheInfo_MaxAgeBeatsExpires(t *testing.T) {
	fetcher := &Fetcher{}
	headers := http.Header{}
	headers.Set("Cache-Control", "max-age=60")
	headers.Set("Expires", time.Now().Add(48*time.Hour).UTC().Format(http.TimeFormat))

	info := fetcher.extractCacheInfo(headers)
	if info.CacheUntil.After(time.Now().Add(2 * time.Minute)) {
		t.Errorf("max-age should take precedence over Expires, got %v", info.CacheUntil)
	}
}

func TestFetcher_ExtractCacheInfo_ParsesExpiresFormats(t *testing.T) {
	fetcher := &Fetcher{}
	// RFC 850 format is a valid HTTP date that time.RFC1123 cannot parse.
	headers := http.Header{}
	headers.Set("Expires", "Sunday, 06-Nov-44 08:49:37 GMT")

	info := fetcher.extractCacheInfo(headers)
	want := time.Date(2044, time.November, 6, 8, 49, 37, 0, time.UTC)
	if !info.CacheUntil.Equal(want) {
		t.Errorf("Expected CacheUntil %v, got %v", want, info.CacheUntil)
	}
}

func TestFetcher_FetchFeed_ConditionalRequest(t *testing.T) {
	const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>Example</title>
<item><guid>1</guid><title>One</title><link>https://example.com/1</link></item>
</channel></rss>`

	var gotETag, gotModified string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotETag = r.Header.Get("If-None-Match")
		gotModified = r.Header.Get("If-Modified-Since")
		if gotETag == `"v1"` {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		w.Header().Set("ETag", `"v1"`)
		w.Header().Set("Cache-Control", "max-age=600")
		_, _ = w.Write([]byte(rss))
	}))
	defer srv.Close()

	fetcher := NewFetcher()

	// Unconditional request returns content and cache information.
	result, err := fetcher.FetchFeed(context.Background(), srv.URL, Validators{})
	if err != nil {
		t.Fatalf("FetchFeed: %v", err)
	}
	if gotETag != "" || gotModified != "" {
		t.Errorf("unconditional request sent validators %q / %q", gotETag, gotModified)
	}
	if result.NotModified() || result.Content.Title != "Example" || len(result.Content.Items) != 1 {
		t.Fatalf("unexpected result %+v", result)
	}
	if result.Cache.ETag != `"v1"` || time.Until(result.Cache.CacheUntil) < 9*time.Minute {
		t.Errorf("unexpected cache info %+v", result.Cache)
	}

	// Conditional request with the stored validators gets 304.
	result, err = fetcher.FetchFeed(context.Background(), srv.URL, Validators{ETag: `"v1"`, LastModified: "Wed, 21 Oct 2015 07:28:00 GMT"})
	if err != nil {
		t.Fatalf("FetchFeed: %v", err)
	}
	if gotModified != "Wed, 21 Oct 2015 07:28:00 GMT" {
		t.Errorf("If-Modified-Since not sent, got %q", gotModified)
	}
	if !result.NotModified() {
		t.Errorf("expected not modified, got %+v", result)
	}
}
