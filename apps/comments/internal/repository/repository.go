package repository

import (
	"aggregat4/go-commentservice/internal/domain"
	"crypto/cipher"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/aggregat4/go-baselib/crypto"
	"github.com/aggregat4/go-baselib/lang"
	"github.com/aggregat4/go-baselib/migrations"
)

type Store struct {
	db     *sql.DB
	Cipher cipher.AEAD
}

func CreateFileDbUrl(dbName string) string {
	return fmt.Sprintf("file:%s.sqlite", dbName)
}

func CreateInMemoryDbUrl() string {
	return ":memory:"
}

func (store *Store) InitAndVerifyDb(dbUrl string) error {
	var err error
	store.db, err = sql.Open("sqlite3", dbUrl)
	if err != nil {
		return err
	}
	return migrations.MigrateSchema(store.db, mymigrations)
}

func (store *Store) Close() error {
	return store.db.Close()
}

func (store *Store) GetServiceForKey(serviceKey string) (*domain.Service, error) {
	rows, err := store.db.Query("SELECT id, origin FROM services WHERE service_key = ?", serviceKey)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if rows.Next() {
		var serviceId int
		var origin string
		err = rows.Scan(&serviceId, &origin)
		if err != nil {
			return nil, err
		}
		return &domain.Service{Id: serviceId, Origin: origin}, nil
	} else {
		return nil, lang.ErrNotFound
	}
}

func (store *Store) FindServiceById(serviceId int) (domain.Service, error) {
	rows, err := store.db.Query("SELECT service_key, origin FROM services WHERE id = ?", serviceId)
	if err != nil {
		return domain.Service{}, err
	}
	defer rows.Close()
	if rows.Next() {
		var serviceKey string
		var origin string
		err = rows.Scan(&serviceKey, &origin)
		if err != nil {
			return domain.Service{}, err
		}
		return domain.Service{Id: serviceId, ServiceKey: serviceKey, Origin: origin}, nil
	} else {
		return domain.Service{}, lang.ErrNotFound
	}
}

func mapComments(rows *sql.Rows, cipher cipher.AEAD) ([]domain.Comment, error) {
	comments := make([]domain.Comment, 0)
	for rows.Next() {
		comment, err := mapComment(rows, cipher)
		if err != nil {
			return nil, err
		}
		comments = append(comments, comment)
	}
	return comments, nil
}

func mapComment(rows *sql.Rows, cipher cipher.AEAD) (domain.Comment, error) {
	var comment domain.Comment
	var commentEncrypted, nameEncrypted, websiteEncrypted []byte
	var edited int
	var createdAt int64
	var err = rows.Scan(&comment.Id, &comment.Status, &comment.UserId, &comment.ServiceId, &comment.PostKey, &commentEncrypted, &nameEncrypted, &websiteEncrypted, &edited, &createdAt)
	if err != nil {
		return domain.Comment{}, err
	}
	comment.CreatedAt = time.Unix(createdAt, 0)
	comment.Comment, err = crypto.DecryptAes256(commentEncrypted, cipher)
	if err != nil {
		return domain.Comment{}, err
	}
	comment.Name, err = crypto.DecryptAes256(nameEncrypted, cipher)
	if err != nil {
		return domain.Comment{}, err
	}
	comment.Website, err = crypto.DecryptAes256(websiteEncrypted, cipher)
	if err != nil {
		return domain.Comment{}, err
	}
	comment.Edited = edited == 1
	return comment, nil
}

func (store *Store) GetCommentsForPost(serviceId int, postKey string) ([]domain.Comment, error) {
	rows, err := store.db.Query("SELECT id, status, user_id, service_id, post_key, comment_encrypted, name_encrypted, website_encrypted, edited, created_at FROM comments WHERE service_id = ? AND post_key = ? AND status = ?", serviceId, postKey, domain.CommentStatusApproved)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return mapComments(rows, store.Cipher)
}

func (store *Store) GetCommentsForUser(userId int) ([]domain.Comment, error) {
	rows, err := store.db.Query("SELECT id, status, user_id, service_id, post_key, comment_encrypted, name_encrypted, website_encrypted, edited, created_at FROM comments WHERE user_id = ?", userId)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return mapComments(rows, store.Cipher)
}

func (store *Store) GetCommentsByStatus(statuses []domain.CommentStatus) ([]domain.Comment, error) {
	query := "SELECT id, status, user_id, service_id, post_key, comment_encrypted, name_encrypted, website_encrypted, edited, created_at FROM comments"
	if len(statuses) > 0 {
		query += " WHERE status IN ("
		query += strings.TrimSuffix(strings.Repeat("?,", len(statuses)), ",")
		query += ")"
	}
	query += " ORDER BY created_at DESC"
	statusInts := make([]interface{}, len(statuses))
	for i, status := range statuses {
		statusInts[i] = int(status)
	}
	rows, err := store.db.Query(query, statusInts...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return mapComments(rows, store.Cipher)
}

func (store *Store) CreateService(serviceKey string, serviceOrigin string) (int, error) {
	result, err := store.db.Exec("INSERT INTO services (service_key, origin) VALUES (?, ?)", serviceKey, serviceOrigin)
	if err != nil {
		return -1, err
	}
	lastInsertId, err := result.LastInsertId()
	if err != nil {
		return -1, err
	}
	return int(lastInsertId), nil
}

func (store *Store) CreateUserByEmail(email string) (int, error) {
	result, err := store.db.Exec(
		"INSERT INTO users (email, auth_token_created_at, auth_token_sent_to_client) VALUES (?, 0, 0)",
		email)
	if err != nil {
		return -1, err
	}
	lastInsertId, err := result.LastInsertId()
	if err != nil {
		return -1, err
	}
	return int(lastInsertId), nil
}

func (store *Store) UpdateUser(user domain.User) error {
	_, err := store.db.Exec("UPDATE users SET auth_token =?, auth_token_created_at =?, auth_token_sent_to_client =? WHERE id =?", user.AuthToken, user.AuthTokenCreatedAt.Unix(), user.AuthTokenSentToClient, user.Id)
	return err
}

func (store *Store) CreateComment(
	status domain.CommentStatus,
	serviceId int,
	userId int,
	postkey string,
	comment string,
	author string,
	website string,
) (int, error) {
	commentEncrypted, err := crypto.EncryptAes256(comment, store.Cipher)
	if err != nil {
		return -1, err
	}
	authorEncrypted, err := crypto.EncryptAes256(author, store.Cipher)
	if err != nil {
		return -1, err
	}
	websiteEncrypted, err := crypto.EncryptAes256(website, store.Cipher)
	if err != nil {
		return -1, err
	}
	result, err := store.db.Exec(
		"INSERT INTO comments (status, service_id, user_id, post_key, comment_encrypted, name_encrypted, website_encrypted, edited) VALUES (?,?,?,?,?,?,?,?)",
		int(status), serviceId, userId, postkey, commentEncrypted, authorEncrypted, websiteEncrypted, 0)
	if err != nil {
		return -1, err
	}
	lastInsertId, err := result.LastInsertId()
	if err != nil {
		return -1, err
	}
	return int(lastInsertId), nil
}

func (store *Store) UpdateComment(
	commentId int,
	previousStatus domain.CommentStatus,
	comment string,
	author string,
	website string,
) error {
	commentEncrypted, err := crypto.EncryptAes256(comment, store.Cipher)
	if err != nil {
		return err
	}
	authorEncrypted, err := crypto.EncryptAes256(author, store.Cipher)
	if err != nil {
		return err
	}
	websiteEncrypted, err := crypto.EncryptAes256(website, store.Cipher)
	if err != nil {
		return err
	}
	_, err = store.db.Exec(
		"UPDATE comments SET status = ?, comment_encrypted = ?, name_encrypted = ?, website_encrypted = ?, edited = 1 WHERE id = ?",
		lang.IfElse(previousStatus == domain.CommentStatusPendingAuthentication, domain.CommentStatusPendingApproval, previousStatus),
		commentEncrypted,
		authorEncrypted,
		websiteEncrypted,
		commentId)
	return err
}

func mapOptionalUser(rows *sql.Rows) (domain.User, error) {
	if rows.Next() {
		var user domain.User
		var authTokenCreatedAt int64
		err := rows.Scan(&user.Id, &user.Email, &user.AuthToken, &authTokenCreatedAt, &user.AuthTokenSentToClient)
		if err != nil {
			return domain.User{}, err
		}
		user.AuthTokenCreatedAt = time.Unix(authTokenCreatedAt, 0)
		return user, nil
	} else {
		return domain.User{}, lang.ErrNotFound
	}
}

func (store *Store) FindUserByEmail(email string) (domain.User, error) {
	rows, err := store.db.Query(
		"SELECT id, email, COALESCE(auth_token, ''), auth_token_created_at, auth_token_sent_to_client FROM users WHERE email = ?",
		email)
	if err != nil {
		return domain.User{}, err
	}
	defer rows.Close()
	return mapOptionalUser(rows)
}

func (store *Store) FindUserById(userId int) (domain.User, error) {
	rows, err := store.db.Query(
		"SELECT id, email, COALESCE(auth_token, ''), auth_token_created_at, auth_token_sent_to_client FROM users WHERE id = ?",
		userId)
	if err != nil {
		return domain.User{}, err
	}
	defer rows.Close()
	return mapOptionalUser(rows)
}

func (store *Store) FindUserByAuthToken(token string) (domain.User, error) {
	rows, err := store.db.Query(
		"SELECT id, email, COALESCE(auth_token, ''), auth_token_created_at, auth_token_sent_to_client FROM users WHERE auth_token = ?",
		token)
	if err != nil {
		return domain.User{}, err
	}
	defer rows.Close()
	return mapOptionalUser(rows)
}

func (store *Store) GetComment(commentId int) (domain.Comment, error) {
	rows, err := store.db.Query(
		"SELECT id, status, user_id, service_id, post_key, comment_encrypted, name_encrypted, website_encrypted, edited, created_at FROM comments WHERE id = ?",
		commentId)
	if err != nil {
		return domain.Comment{}, err
	}
	defer rows.Close()
	if rows.Next() {
		comment, err := mapComment(rows, store.Cipher)
		if err != nil {
			return domain.Comment{}, err
		}
		return comment, nil
	} else {
		return domain.Comment{}, lang.ErrNotFound
	}
}

func (store *Store) DeleteComment(commentId int) error {
	result, err := store.db.Exec("DELETE FROM comments WHERE id = ?", commentId)
	if err != nil {
		return err
	}
	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return err
	} else if rowsAffected == 0 {
		return lang.ErrNotFound
	} else if rowsAffected > 1 {
		return errors.New("more than one row was affected by the delete operation")
	} else {
		return nil
	}
}
