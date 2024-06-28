package repository

import (
	"aggregat4/go-commentservice/internal/domain"
	"crypto/cipher"
	"database/sql"
	"fmt"
	"github.com/aggregat4/go-baselib/crypto"
	"github.com/aggregat4/go-baselib/migrations"
	"time"
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
		return nil, nil
	}
}

func (store *Store) GetComments(serviceId int, postKey string) ([]domain.Comment, error) {
	rows, err := store.db.Query("SELECT id, user_id, comment_encrypted, name_encrypted, website_encrypted, created_at FROM comments WHERE service_id = ? AND post_key = ?", serviceId, postKey)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	comments := make([]domain.Comment, 0)
	for rows.Next() {
		var comment domain.Comment
		var commentEncrypted, nameEncrypted, websiteEncrypted []byte
		var createdAt int64
		err = rows.Scan(&comment.Id, &comment.UserId, &commentEncrypted, &nameEncrypted, &websiteEncrypted, &createdAt)
		if err != nil {
			return nil, err
		}
		comment.ServiceId = serviceId
		comment.PostKey = postKey
		comment.CreatedAt = time.Unix(createdAt, 0)
		comment.Comment, err = crypto.DecryptAes256(commentEncrypted, store.Cipher)
		if err != nil {
			return nil, err
		}
		comment.Name, err = crypto.DecryptAes256(nameEncrypted, store.Cipher)
		if err != nil {
			return nil, err
		}
		comment.Website, err = crypto.DecryptAes256(websiteEncrypted, store.Cipher)
		if err != nil {
			return nil, err
		}
		comments = append(comments, comment)
	}
	return comments, nil
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

func (store *Store) CreateUser(email string) (int, error) {
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

func (store *Store) CreateComment(
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
		"INSERT INTO comments (service_id, user_id, post_key, comment_encrypted, name_encrypted, website_encrypted) VALUES (?,?,?,?,?,?)",
		serviceId, userId, postkey, commentEncrypted, authorEncrypted, websiteEncrypted)
	if err != nil {
		return -1, err
	}
	lastInsertId, err := result.LastInsertId()
	if err != nil {
		return -1, err
	}
	return int(lastInsertId), nil
}

func (store *Store) FindUserByEmail(email string) (domain.User, error) {
	rows, err := store.db.Query(
		"SELECT id, email, COALESCE(auth_token, ''), auth_token_created_at, auth_token_sent_to_client FROM users WHERE email = ?",
		email)
	if err != nil {
		return domain.User{}, err
	}
	defer rows.Close()
	if rows.Next() {
		var user domain.User
		var authTokenCreatedAt int64
		err = rows.Scan(&user.Id, &user.Email, &user.AuthToken, &authTokenCreatedAt, &user.AuthTokenSentToClient)
		if err != nil {
			return domain.User{}, err
		}
		user.AuthTokenCreatedAt = time.Unix(authTokenCreatedAt, 0)
		return user, nil
	} else {
		return domain.User{}, nil
	}
}

func (store *Store) FindUserByAuthToken(token string) (domain.User, error) {
	rows, err := store.db.Query(
		"SELECT id, email, COALESCE(auth_token, ''), auth_token_created_at, auth_token_sent_to_client FROM users WHERE auth_token = ?",
		token)
	if err != nil {
		return domain.User{}, err
	}
	defer rows.Close()
	if rows.Next() {
		var user domain.User
		var authTokenCreatedAt int64
		err = rows.Scan(&user.Id, &user.Email, &user.AuthToken, &authTokenCreatedAt, &user.AuthTokenSentToClient)
		if err != nil {
			return domain.User{}, err
		}
		user.AuthTokenCreatedAt = time.Unix(authTokenCreatedAt, 0)
		return user, nil
	} else {
		return domain.User{}, nil
	}
}

func (store *Store) UpdateUser(user domain.User) error {
	_, err := store.db.Exec("UPDATE users SET auth_token =?, auth_token_created_at =?, auth_token_sent_to_client =? WHERE id =?", user.AuthToken, user.AuthTokenCreatedAt, user.AuthTokenSentToClient, user.Id)
	return err
}
