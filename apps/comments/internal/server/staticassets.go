package server

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"fmt"
	"html/template"
	"io"
	"io/fs"
	"net/http"
	"path"
	"strings"

	"github.com/labstack/echo/v4"
)

type templateData struct {
	Data      interface{}
	AssetPath func(string) string
}

type EchoTemplateRenderer struct {
	templates map[string]*template.Template
}

func (t *EchoTemplateRenderer) Render(w io.Writer, name string, data interface{}, c echo.Context) error {
	var tmplData = templateData{
		Data:      data,
		AssetPath: getHashedAssetPath,
	}
	return t.templates[name].ExecuteTemplate(w, name, tmplData)
}

// Helper function to get hashed URL for a static asset
func getHashedAssetPath(originalPath string) string {
	if info, exists := staticAssets[originalPath]; exists {
		return "/" + info.hashedPath
	}
	return "/" + originalPath
}

// staticAssetInfo holds information about a static asset including its hash
type staticAssetInfo struct {
	originalPath string
	hashedPath   string
	contentHash  string
}

// staticAssets holds a mapping of original paths to their hashed versions
var staticAssets = make(map[string]staticAssetInfo)

// calculateFileHash generates a SHA-256 hash of a file's contents
func calculateFileHash(file fs.File) (string, error) {
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil))[:12], nil // Use first 12 chars of hash
}

// initializeStaticAssets processes embedded files and generates content hashes
func initializeStaticAssets(filesystem embed.FS, prefix string) error {
	return fs.WalkDir(filesystem, ".", func(filePath string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}

		file, err := filesystem.Open(filePath)
		if err != nil {
			return err
		}
		defer file.Close()

		hash, err := calculateFileHash(file)
		if err != nil {
			return err
		}

		filename := d.Name()

		// Create the hashed path by inserting the hash before the file extension
		ext := path.Ext(filename)
		basePath := strings.TrimSuffix(filename, ext)
		hashedPath := fmt.Sprintf("%s.%s%s", basePath, hash, ext)

		// Store the mapping
		logicalpath := path.Join(prefix, filename)
		staticAssets[logicalpath] = staticAssetInfo{
			originalPath: filePath,
			hashedPath:   path.Join(prefix, hashedPath),
			contentHash:  hash,
		}

		return nil
	})
}

// hashedStaticHandler creates a handler that serves static files with their content hashes in URLs
func hashedStaticHandler(filesystem embed.FS, prefix string) echo.HandlerFunc {
	fileServer := http.FileServer(http.FS(filesystem))

	return func(c echo.Context) error {
		requestPath := c.Request().URL.Path

		// Check if this is a request for a hashed file
		for _, info := range staticAssets {
			if strings.HasSuffix(requestPath, path.Base(info.hashedPath)) {
				// Set strong caching headers
				c.Response().Header().Set("Cache-Control", "public, max-age=31536000, immutable") // 1 year
				c.Response().Header().Set("ETag", fmt.Sprintf(`"%s"`, info.contentHash))

				// Serve the file from its original path
				req := c.Request().Clone(c.Request().Context())
				req.URL.Path = "/" + strings.TrimPrefix(info.originalPath, prefix+"/")
				fileServer.ServeHTTP(c.Response(), req)
				return nil
			}
		}

		return echo.NewHTTPError(http.StatusNotFound)
	}
}
