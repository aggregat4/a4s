package main

import (
	"errors"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

func TestValidateStaticAssetsAcceptsRequiredFiles(t *testing.T) {
	t.Parallel()

	if err := validateStaticAssets(testStaticFS()); err != nil {
		t.Fatalf("validateStaticAssets returned error: %v", err)
	}
}

func TestValidateStaticAssetsRejectsMissingRequiredFile(t *testing.T) {
	t.Parallel()

	staticFS := testStaticFS()
	delete(staticFS, "entrypoints/main.js")

	err := validateStaticAssets(staticFS)
	if err == nil {
		t.Fatal("validateStaticAssets returned nil error")
	}

	missingErr, ok := err.(*missingStaticFileError)
	if !ok {
		t.Fatalf("expected missingStaticFileError, got %T", err)
	}
	if missingErr.Path != "entrypoints/main.js" {
		t.Fatalf("unexpected missing path: %s", missingErr.Path)
	}
	if missingErr.Err == nil || !errors.Is(missingErr.Err, fs.ErrNotExist) {
		t.Fatalf("expected fs.ErrNotExist, got %v", missingErr.Err)
	}
}

func testStaticFS() fstest.MapFS {
	staticFS := fstest.MapFS{}
	for _, assetPath := range requiredStaticAssets {
		staticFS[assetPath] = &fstest.MapFile{Data: []byte("ok")}
	}
	return staticFS
}

func TestRegisterEmbeddedFSServesExistingAsset(t *testing.T) {
	t.Parallel()

	staticFS := fstest.MapFS{
		"index.html":          &fstest.MapFile{Data: []byte("<!doctype html>")},
		"styles.css":          &fstest.MapFile{Data: []byte("body { color: red; }")},
		"entrypoints/main.js": &fstest.MapFile{Data: []byte("console.log('ok');")},
	}

	mux := http.NewServeMux()
	registerEmbeddedFS(mux, staticFS)

	req := httptest.NewRequest(http.MethodGet, "/styles.css", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("unexpected status: %d", rec.Code)
	}
	if body := rec.Body.String(); !strings.Contains(body, "color: red") {
		t.Fatalf("expected css body, got %q", body)
	}
	if contentType := rec.Header().Get("Content-Type"); !strings.HasPrefix(contentType, "text/css") {
		t.Fatalf("unexpected content type: %q", contentType)
	}
}

func TestRegisterEmbeddedFSReturnsNotFoundForInvalidRoute(t *testing.T) {
	t.Parallel()

	staticFS := fstest.MapFS{
		"index.html":          &fstest.MapFile{Data: []byte("<!doctype html><title>app</title>")},
		"styles.css":          &fstest.MapFile{Data: []byte("body {}")},
		"entrypoints/main.js": &fstest.MapFile{Data: []byte("console.log('ok');")},
	}

	mux := http.NewServeMux()
	registerEmbeddedFS(mux, staticFS)

	req := httptest.NewRequest(http.MethodGet, "/lists/inbox", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d with body %q", rec.Code, rec.Body.String())
	}
}

func TestRegisterEmbeddedFSReturnsNotFoundForMissingAsset(t *testing.T) {
	t.Parallel()

	staticFS := fstest.MapFS{
		"index.html":          &fstest.MapFile{Data: []byte("<!doctype html><title>app</title>")},
		"styles.css":          &fstest.MapFile{Data: []byte("body {}")},
		"entrypoints/main.js": &fstest.MapFile{Data: []byte("console.log('ok');")},
	}

	mux := http.NewServeMux()
	registerEmbeddedFS(mux, staticFS)

	req := httptest.NewRequest(http.MethodGet, "/favicon.ico", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d with body %q", rec.Code, rec.Body.String())
	}
}

func TestRegisterStaticDirReturnsNotFoundForMissingAsset(t *testing.T) {
	t.Parallel()

	staticDir := t.TempDir()
	writeTestFile(t, staticDir, "index.html", "<!doctype html><title>app</title>")
	writeTestFile(t, staticDir, "styles.css", "body {}")
	writeTestFile(t, staticDir, "entrypoints/main.js", "console.log('ok');")

	mux := http.NewServeMux()
	registerStaticDir(mux, staticDir)

	req := httptest.NewRequest(http.MethodGet, "/favicon.ico", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d with body %q", rec.Code, rec.Body.String())
	}
}

func writeTestFile(t *testing.T, root, relativePath, content string) {
	t.Helper()

	fullPath := filepath.Join(root, filepath.FromSlash(relativePath))
	if err := os.MkdirAll(filepath.Dir(fullPath), 0o755); err != nil {
		t.Fatalf("mkdir failed: %v", err)
	}
	if err := os.WriteFile(fullPath, []byte(content), 0o644); err != nil {
		t.Fatalf("write file failed: %v", err)
	}
}
