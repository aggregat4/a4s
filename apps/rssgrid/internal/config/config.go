package config

import (
	"errors"
	"fmt"
	"time"

	"github.com/kirsle/configdir"
	"github.com/kkyr/fig"
)

// PlaceholderSessionKey is the value shipped in the example config; it must be
// replaced before the server is allowed to start.
const PlaceholderSessionKey = "your-secure-session-key"

// MinSessionKeyBytes is the minimum acceptable session key length.
const MinSessionKeyBytes = 32

type Config struct {
	Addr            string        `fig:"addr" default:":8080"`
	DBPath          string        `fig:"db_path" default:"rssgrid.db"`
	UpdateInterval  time.Duration `fig:"update_interval" default:"30m"`
	MaxPostsPerFeed int           `fig:"max_posts_per_feed" default:"100"`
	SessionKey      string        `fig:"session_key" env:"RSSGRID_SESSION_KEY" required:"true"`
	SecureCookies   bool          `fig:"secure_cookies"`
	OIDC            struct {
		IssuerURL    string `fig:"issuer_url" env:"RSSGRID_OIDC_ISSUER_URL" required:"true"`
		ClientID     string `fig:"client_id" env:"RSSGRID_OIDC_CLIENT_ID" required:"true"`
		ClientSecret string `fig:"client_secret" env:"RSSGRID_OIDC_CLIENT_SECRET" required:"true"`
		RedirectURL  string `fig:"redirect_url" default:"http://localhost:8080/auth/callback"`
	} `fig:"oidc"`
}

// Validate checks the loaded configuration for values that are syntactically
// acceptable to the config loader but unsafe to run with. It should be called
// after Load/LoadWithPath, before starting the server.
func (c *Config) Validate() error {
	if c.SessionKey == PlaceholderSessionKey {
		return errors.New("session key must be set to a random value of at least 32 bytes (the placeholder value is not allowed)")
	}
	if len(c.SessionKey) < MinSessionKeyBytes {
		return fmt.Errorf("session key must be at least %d bytes, got %d", MinSessionKeyBytes, len(c.SessionKey))
	}
	return nil
}

func Load() (*Config, error) {
	configDir := configdir.LocalConfig("rssgrid")
	return LoadWithPath(configDir)
}

func LoadWithPath(configPath string) (*Config, error) {
	var cfg Config
	if err := fig.Load(&cfg,
		fig.File("rssgrid.json"),
		fig.Dirs(configPath),
		fig.UseEnv("RSSGRID"),
	); err != nil {
		return nil, err
	}
	return &cfg, nil
}
