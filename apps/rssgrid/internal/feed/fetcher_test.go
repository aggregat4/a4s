package feed

import (
	"net/http"
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

	if cacheInfo.etag != `"abc123"` {
		t.Errorf("Expected ETag to be \"abc123\", got %s", cacheInfo.etag)
	}

	if cacheInfo.lastModified != "Wed, 21 Oct 2015 07:28:00 GMT" {
		t.Errorf("Expected Last-Modified to be \"Wed, 21 Oct 2015 07:28:00 GMT\", got %s", cacheInfo.lastModified)
	}

	// Check that cache_until is set to a future time (within reasonable bounds)
	expectedMin := time.Now().Add(3599 * time.Second) // 1 hour - 1 second
	expectedMax := time.Now().Add(3601 * time.Second) // 1 hour + 1 second
	if cacheInfo.cacheUntil.Before(expectedMin) || cacheInfo.cacheUntil.After(expectedMax) {
		t.Errorf("Expected CacheUntil to be around 1 hour from now, got %v", cacheInfo.cacheUntil)
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
	if info.cacheUntil.After(time.Now().Add(2 * time.Minute)) {
		t.Errorf("max-age should take precedence over Expires, got %v", info.cacheUntil)
	}
}

func TestFetcher_ExtractCacheInfo_ParsesExpiresFormats(t *testing.T) {
	fetcher := &Fetcher{}
	// RFC 850 format is a valid HTTP date that time.RFC1123 cannot parse.
	headers := http.Header{}
	headers.Set("Expires", "Sunday, 06-Nov-44 08:49:37 GMT")

	info := fetcher.extractCacheInfo(headers)
	want := time.Date(2044, time.November, 6, 8, 49, 37, 0, time.UTC)
	if !info.cacheUntil.Equal(want) {
		t.Errorf("Expected CacheUntil %v, got %v", want, info.cacheUntil)
	}
}
