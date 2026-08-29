package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// unsetRSSGridEnv unsets all RSSGRID_* environment variables for the duration
// of the test and restores them on cleanup, so file-based config isn't
// overridden by the ambient environment.
func unsetRSSGridEnv(t *testing.T) {
	t.Helper()
	var toRestore []string
	for _, kv := range os.Environ() {
		if strings.HasPrefix(kv, "RSSGRID_") {
			parts := strings.SplitN(kv, "=", 2)
			key := parts[0]
			val := ""
			if len(parts) == 2 {
				val = parts[1]
			}
			toRestore = append(toRestore, key)
			_ = os.Unsetenv(key)
			t.Cleanup(func() { _ = os.Setenv(key, val) })
		}
	}
	_ = toRestore
}

// writeConfig writes a rssgrid.json into a temp dir with the given session key
// and secure_cookies value, and returns the dir path.
func writeConfig(t *testing.T, sessionKey string, secureCookies bool) string {
	t.Helper()
	dir := t.TempDir()
	content := `{
  "addr": ":8080",
  "db_path": "rssgrid.db",
  "update_interval": "30m",
  "max_posts_per_feed": 100,
  "session_key": "` + sessionKey + `",
  "secure_cookies": ` + boolStr(secureCookies) + `,
  "oidc": {
    "issuer_url": "https://issuer.example.com",
    "client_id": "client-id",
    "client_secret": "client-secret",
    "redirect_url": "http://localhost:8080/auth/callback"
  }
}`
	require.NoError(t, os.WriteFile(filepath.Join(dir, "rssgrid.json"), []byte(content), 0644))
	return dir
}

func boolStr(b bool) string {
	if b {
		return "true"
	}
	return "false"
}

func TestValidate_RejectsPlaceholderKey(t *testing.T) {
	unsetRSSGridEnv(t)
	cfg := &Config{SessionKey: "your-secure-session-key"}
	err := cfg.Validate()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "session key")
}

func TestValidate_RejectsShortKey(t *testing.T) {
	unsetRSSGridEnv(t)
	cfg := &Config{SessionKey: "short"}
	err := cfg.Validate()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "32 bytes")
}

func TestValidate_AcceptsValidKey(t *testing.T) {
	unsetRSSGridEnv(t)
	cfg := &Config{SessionKey: strings.Repeat("a", 32)}
	assert.NoError(t, cfg.Validate())
}

func TestLoad_SecureCookiesDefaultsFalse(t *testing.T) {
	unsetRSSGridEnv(t)
	dir := writeConfig(t, strings.Repeat("a", 32), false)
	cfg, err := LoadWithPath(dir)
	require.NoError(t, err)
	assert.False(t, cfg.SecureCookies, "SecureCookies should default to false")
}

func TestLoad_SecureCookiesHonoredFromFile(t *testing.T) {
	unsetRSSGridEnv(t)
	dir := writeConfig(t, strings.Repeat("a", 32), true)
	cfg, err := LoadWithPath(dir)
	require.NoError(t, err)
	assert.True(t, cfg.SecureCookies, "SecureCookies should be true when set in the config file")
}

func TestLoad_PlaceholderKeyLoadsButValidateFails(t *testing.T) {
	unsetRSSGridEnv(t)
	// The placeholder satisfies fig's `required` check (it's a non-empty
	// string), so Load succeeds; Validate is what rejects it.
	dir := writeConfig(t, "your-secure-session-key", false)
	cfg, err := LoadWithPath(dir)
	require.NoError(t, err)
	require.NotNil(t, cfg)
	require.Error(t, cfg.Validate(), "Validate must reject the placeholder key even though Load succeeded")
}

func TestLoad_ShortKeyLoadsButValidateFails(t *testing.T) {
	unsetRSSGridEnv(t)
	dir := writeConfig(t, "too-short", false)
	cfg, err := LoadWithPath(dir)
	require.NoError(t, err)
	require.Error(t, cfg.Validate())
}
