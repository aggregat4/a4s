package templates

import (
	"bytes"
	"testing"
	"time"
)

func TestReltime(t *testing.T) {
	tests := []struct {
		name string
		t    time.Time
		want string
	}{
		{"zero", time.Time{}, "never"},
		{"just now", time.Now().Add(-5 * time.Second), "just now"},
		{"one minute", time.Now().Add(-1 * time.Minute), "1 minute ago"},
		{"minutes", time.Now().Add(-5 * time.Minute), "5 minutes ago"},
		{"one hour", time.Now().Add(-1 * time.Hour), "1 hour ago"},
		{"hours", time.Now().Add(-3 * time.Hour), "3 hours ago"},
		{"one day", time.Now().Add(-24 * time.Hour), "1 day ago"},
		{"days", time.Now().Add(-72 * time.Hour), "3 days ago"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := reltime(tt.t); got != tt.want {
				t.Errorf("reltime() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestSettingsTemplate_RendersFeedHealthBadge(t *testing.T) {
	tmpl, err := LoadTemplates()
	if err != nil {
		t.Fatalf("Failed to load templates: %v", err)
	}

	settings := tmpl.Lookup("settings.html")
	if settings == nil {
		t.Fatal("settings.html template not found")
	}

	type feedLike struct {
		ID                  int64
		Title               string
		URL                 string
		ConsecutiveFailures int
		LastError           string
		LastErrorAt         time.Time
		LastSuccessAt       time.Time
		LastFetchedAt       time.Time
	}

	data := struct {
		Feeds         []feedLike
		FlashMessages []struct{ Type, Message string }
		PostsPerFeed  int
		Columns       int
	}{
		Feeds: []feedLike{
			{ID: 1, Title: "Healthy Feed", URL: "https://example.com/healthy.xml"},
			{ID: 2, Title: "Broken Feed", URL: "https://example.com/broken.xml", ConsecutiveFailures: 3, LastError: "connection refused", LastErrorAt: time.Now()},
		},
		PostsPerFeed: 10,
		Columns:      2,
	}

	var buf bytes.Buffer
	if err := settings.Execute(&buf, data); err != nil {
		t.Fatalf("Failed to execute settings template: %v", err)
	}

	out := buf.String()
	if !contains(out, "Failing: connection refused") {
		t.Errorf("expected output to surface the failing feed's error, got:\n%s", out)
	}
	if !contains(out, "(3x)") {
		t.Errorf("expected output to show consecutive failure count (3x), got:\n%s", out)
	}
	if !contains(out, "Last fetched:") {
		t.Errorf("expected output to show a 'Last fetched' line, got:\n%s", out)
	}
	// The healthy feed must not render a failure badge.
	// A simple sanity check: the failure count text appears exactly once.
	if count := occurrences(out, "Failing:"); count != 1 {
		t.Errorf("expected exactly one failing feed rendered, got %d", count)
	}
}

func contains(s, sub string) bool {
	return bytes.Contains([]byte(s), []byte(sub))
}

func occurrences(s, sub string) int {
	var n int
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			n++
			i += len(sub) - 1
		}
	}
	return n
}

func TestHostTemplateFunc(t *testing.T) {
	tests := []struct {
		name string
		url  string
		want string
	}{
		{"plain https", "https://example.com/feed.xml", "example.com"},
		{"with port", "http://localhost:8080/feed", "localhost:8080"},
		{"with subdomain", "https://blog.example.com/rss", "blog.example.com"},
		{"malformed falls back to raw", "://not-a-url", "://not-a-url"},
		{"empty stays empty", "", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := host(tt.url); got != tt.want {
				t.Errorf("host(%q) = %q, want %q", tt.url, got, tt.want)
			}
		})
	}
}

func TestTemplatesIncludeFaviconLink(t *testing.T) {
	tmpl, err := LoadTemplates()
	if err != nil {
		t.Fatalf("Failed to load templates: %v", err)
	}
	for _, name := range []string{"dashboard.html", "settings.html", "post.html"} {
		t.Run(name, func(t *testing.T) {
			tTmpl := tmpl.Lookup(name)
			if tTmpl == nil {
				t.Fatalf("template %s not found", name)
			}
			// Render with nil data; we only care that the <link> tag is in the head.
			var buf bytes.Buffer
			// dashboard/settings/post all tolerate an empty data struct for the
			// purpose of checking the static <head> contents.
			if err := tTmpl.Execute(&buf, nil); err != nil {
				// Some templates range over data and may error on nil; fall back to
				// inspecting the raw template source for the link tag.
				raw, readErr := templateFS.ReadFile(name)
				if readErr != nil {
					t.Fatalf("failed to read template %s: %v", name, readErr)
				}
				if !contains(string(raw), `rel="icon"`) || !contains(string(raw), `/favicon.svg`) {
					t.Errorf("template %s must reference /favicon.svg via a rel=icon link", name)
				}
				return
			}
			out := buf.String()
			if !contains(out, `rel="icon"`) || !contains(out, `/favicon.svg`) {
				t.Errorf("template %s output must reference /favicon.svg via a rel=icon link, got:\n%s", name, out)
			}
		})
	}
}

func TestDashboardTemplate_TitleFallbackToHost(t *testing.T) {
	tmpl, err := LoadTemplates()
	if err != nil {
		t.Fatalf("Failed to load templates: %v", err)
	}

	type feedLike struct {
		ID                  int64
		Title               string
		URL                 string
		ConsecutiveFailures int
		LastError           string
	}
	type postData struct {
		Feed  feedLike
		Posts []struct{}
	}
	columns := [][]postData{
		{
			{Feed: feedLike{ID: 1, Title: "", URL: "https://example.com/feed.xml"}},
		},
	}
	data := struct {
		Columns     [][]postData
		ColumnCount int
	}{
		Columns:     columns,
		ColumnCount: 1,
	}

	var buf bytes.Buffer
	if err := tmpl.Lookup("dashboard.html").Execute(&buf, data); err != nil {
		t.Fatalf("Failed to execute dashboard template: %v", err)
	}
	out := buf.String()
	if !contains(out, "example.com") {
		t.Errorf("expected the feed URL host 'example.com' to appear as a title fallback, got:\n%s", out)
	}
}

func TestSettingsTemplate_TitleFallbackToHost(t *testing.T) {
	tmpl, err := LoadTemplates()
	if err != nil {
		t.Fatalf("Failed to load templates: %v", err)
	}

	type feedLike struct {
		ID                  int64
		Title               string
		URL                 string
		ConsecutiveFailures int
		LastError           string
		LastErrorAt         time.Time
		LastSuccessAt       time.Time
		LastFetchedAt       time.Time
	}
	data := struct {
		Feeds         []feedLike
		FlashMessages []struct{ Type, Message string }
		PostsPerFeed  int
		Columns       int
	}{
		Feeds: []feedLike{
			{ID: 1, Title: "", URL: "https://blog.example.com/rss"},
		},
		PostsPerFeed: 10,
		Columns:      2,
	}

	var buf bytes.Buffer
	if err := tmpl.Lookup("settings.html").Execute(&buf, data); err != nil {
		t.Fatalf("Failed to execute settings template: %v", err)
	}
	out := buf.String()
	if !contains(out, "blog.example.com") {
		t.Errorf("expected the feed URL host 'blog.example.com' to appear as a title fallback, got:\n%s", out)
	}
}
