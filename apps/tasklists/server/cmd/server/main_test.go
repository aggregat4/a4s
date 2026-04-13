package main

import (
	"errors"
	"io/fs"
	"testing"
	"testing/fstest"
)

func TestValidateStaticAssetsAcceptsRequiredFiles(t *testing.T) {
	t.Parallel()

	staticFS := fstest.MapFS{
		"index.html":          &fstest.MapFile{Data: []byte("ok")},
		"styles.css":          &fstest.MapFile{Data: []byte("ok")},
		"entrypoints/main.js": &fstest.MapFile{Data: []byte("ok")},
	}

	if err := validateStaticAssets(staticFS); err != nil {
		t.Fatalf("validateStaticAssets returned error: %v", err)
	}
}

func TestValidateStaticAssetsRejectsMissingRequiredFile(t *testing.T) {
	t.Parallel()

	staticFS := fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("ok")},
		"styles.css": &fstest.MapFile{Data: []byte("ok")},
	}

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
