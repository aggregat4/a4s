package domain

import (
	"time"
)

type Config struct {
	Port                      int    `fig:"port" validate:"required"`
	DatabaseFilename          string `fig:"database_filename" validate:"required"`
	ServerReadTimeoutSeconds  int    `fig:"server_read_timeout_seconds" validate:"required"`
	ServerWriteTimeoutSeconds int    `fig:"server_write_timeout_seconds" validate:"required"`
	OidcIdpServer             string
	OidcClientId              string
	OidcClientSecret          string
	OidcRedirectUri           string
	EncryptionKey             string
}

type User struct {
	Id                    int
	Email                 string
	AuthToken             string
	AuthTokenCreatedAt    time.Time
	AuthTokenSentToClient int
}

type Service struct {
	Id         int
	ServiceKey string
	Origin     string
}

type CommentStatus int

const (
	_ CommentStatus = iota
	PendingAuthentication
	PendingApproval
	Approved
	Rejected
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
	CreatedAt time.Time
}

type PostCommentsPage struct {
	ServiceKey string
	PostKey    string
	UserId     int // can be empty, identified by -1
	Comments   []Comment
}

type UserCommentsPage struct {
	User     User
	Comments []Comment
}

type NoDataForUserPage struct {
	Email string
}
