package domain

import (
	"fmt"
	"time"
)

type Config struct {
	Port                      int    `fig:"port" validate:"required"`
	DatabaseFilename          string `fig:"database_filename" validate:"required"`
	ServerReadTimeoutSeconds  int    `fig:"server_read_timeout_seconds" default:"5"`
	ServerWriteTimeoutSeconds int    `fig:"server_write_timeout_seconds" default:"10"`
	OidcIdpServer             string `fig:"oidc_idp_server" validate:"required"`
	OidcClientId              string `fig:"oidc_client_id" validate:"required"`
	OidcClientSecret          string `fig:"oidc_client_secret" validate:"required"`
	OidcRedirectUri           string `fig:"oidc_redirect_uri" validate:"required"`
	EncryptionKey             string `fig:"encryption_key" validate:"required"`
	SessionCookieSecretKey    string `fig:"session_cookie_secret_key" validate:"required"`
	SessionCookieSecureFlag   bool   `fig:"session_cookie_secure_flag" validate:"required"` // sadly fig can not set default values for booleans, see https://github.com/kkyr/fig/issues/13
}

type User struct {
	Id                    int
	Email                 string
	AuthToken             string
	AuthTokenCreatedAt    time.Time
	AuthTokenSentToClient int
}

func (u User) IsValid() bool {
	return u.Id != 0
}

type AdminUser struct {
	UserId string
}

type Service struct {
	Id         int
	ServiceKey string
	Origin     string
}

type CommentStatus int

const (
	_ CommentStatus = iota
	CommentStatusPendingAuthentication
	CommentStatusPendingApproval
	CommentStatusApproved
	CommentStatusRejected
)

func ParseCommentStatus(status string) (CommentStatus, error) {
	switch status {
	case "pending-authentication":
		return CommentStatusPendingAuthentication, nil
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
	Id        int
	Status    CommentStatus
	ServiceId int
	UserId    int
	PostKey   string
	Comment   string
	Name      string
	Website   string
	Edited    bool
	CreatedAt time.Time
}

type PostCommentsPage struct {
	ServiceKey string
	PostKey    string
	UserId     int // can be empty, identified by -1
	Comments   []Comment
	Success    []string
	Error      []string
}

type UserCommentsPage struct {
	User     User
	Comments []Comment
}

type NoDataForUserPage struct {
	Email string
}

type AddOrEditCommentPage struct {
	ServiceKey   string
	PostKey      string
	UserFound    bool
	User         User
	CommentFound bool
	Comment      Comment
}

type UserAuthenticationPage struct {
	EmailAddress string
	Success      []string
	Error        []string
}

type AdminDashboardPage struct {
	AdminUser AdminUser
	Comments  []Comment
	Statuses  []CommentStatus
	Success   []string
	Error     []string
}
