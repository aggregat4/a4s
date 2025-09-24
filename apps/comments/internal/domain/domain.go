package domain

import (
	"fmt"
	"net/http"
	"slices"
	"strings"
	"time"
)

type Config struct {
	Port                        int    `fig:"port" validate:"required"`
	DatabaseFilename            string `fig:"database_filename" validate:"required"`
	ServerReadTimeoutSeconds    int    `fig:"server_read_timeout_seconds" default:"5"`
	ServerWriteTimeoutSeconds   int    `fig:"server_write_timeout_seconds" default:"10"`
	BaseURL                     string `fig:"base_url" validate:"required"` // Base URL where the service is hosted (e.g. https://comments.example.com)
	OidcIdpServer               string `fig:"oidc_idp_server" validate:"required"`
	OidcClientId                string `fig:"oidc_client_id" validate:"required"`
	OidcClientSecret            string `fig:"oidc_client_secret" validate:"required"`
	OidcRedirectUri             string `fig:"oidc_redirect_uri" validate:"required"`
	EncryptionKey               string `fig:"encryption_key" validate:"required"`
	SessionCookieSecretKey      string `fig:"session_cookie_secret_key" validate:"required"`
	SessionCookieSecureFlag     bool   `fig:"session_cookie_secure_flag" validate:"required"` // sadly fig can not set default values for booleans, see https://github.com/kkyr/fig/issues/13
	SessionCookieCookieMaxAge   int    `fig:"session_cookie_max_age" default:"2592000"`       // Max age in seconds, 0 = session cookie, default 2592000 is 30 days
	SessionCookieCookieSameSite string `fig:"session_cookie_same_site" default:"none"`        // SameSite policy
}

func SameSiteFromString(sameSite string) http.SameSite {
	switch strings.ToLower(sameSite) {
	case "lax":
		return http.SameSiteLaxMode
	case "strict":
		return http.SameSiteStrictMode
	case "none":
		return http.SameSiteNoneMode
	default:
		return http.SameSiteDefaultMode
	}
}

type User struct {
	Id             int
	ExternalUserId string
}

func (u User) IsValid() bool {
	return u.Id != 0
}

type AdminUser struct {
	UserId string
	Roles  []string
}

type AuthContext struct {
	User         *User
	AdminUser    *AdminUser
	IsAdmin      bool
	IsSuperAdmin bool
}

func (a *AdminUser) HasServiceAdminRole(serviceKey string) bool {
	if a == nil {
		return false
	}
	targetRole := "admin-" + serviceKey
	for _, role := range a.Roles {
		if role == targetRole || role == "superadmin" {
			return true
		}
	}
	return false
}

func (a *AdminUser) IsSuperAdmin() bool {
	if a == nil {
		return false
	}
	return slices.Contains(a.Roles, "superadmin")
}

type Service struct {
	Id         int
	ServiceKey string
	Origin     string
}

type CommentStatus int

const (
	_ CommentStatus = iota
	CommentStatusPendingApproval
	CommentStatusApproved
	CommentStatusRejected
)

func ParseCommentStatus(status string) (CommentStatus, error) {
	switch status {
	case "pending-approval":
		return CommentStatusPendingApproval, nil
	case "approved":
		return CommentStatusApproved, nil
	case "rejected":
		return CommentStatusRejected, nil
	default:
		return -1, fmt.Errorf("invalid comment status: %s", status)
	}
}

type Comment struct {
	Id         int
	Status     CommentStatus
	ServiceId  int
	ServiceKey string
	UserId     int
	PostKey    string
	Comment    string
	Name       string
	Website    string
	Edited     bool
	CreatedAt  time.Time
	ParentUrl  string
}
