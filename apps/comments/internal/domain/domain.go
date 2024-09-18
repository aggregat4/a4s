package domain

import (
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
