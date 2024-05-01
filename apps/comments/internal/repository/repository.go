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
	aesKey cipher.AEAD
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

func (store *Store) GetServiceForKey(serviceKey string) (domain.Service, error) {
	rows, err := store.db.Query("SELECT id, origin FROM services WHERE service_key = ?", serviceKey)
	if err != nil {
		return domain.Service{}, err
	}
	defer rows.Close()
	if rows.Next() {
		var serviceId int
		var origin string
		err = rows.Scan(&serviceId, &origin)
		if err != nil {
			return domain.Service{}, err
		}
		return domain.Service{Id: serviceId, Origin: origin}, nil
	} else {
		return domain.Service{}, nil
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
		var created int64
		var commentEncrypted, nameEncrypted, websiteEncrypted []byte
		err = rows.Scan(&comment.Id, &comment.UserId, &commentEncrypted, &nameEncrypted, &websiteEncrypted, &created)
		if err != nil {
			return nil, err
		}
		comment.ServiceId = serviceId
		comment.PostKey = postKey
		comment.CreatedAt = time.Unix(created, 0)
		comment.Comment, err = crypto.DecryptAes256(commentEncrypted, store.aesKey)
		if err != nil {
			return nil, err
		}
		comment.Name, err = crypto.DecryptAes256(nameEncrypted, store.aesKey)
		if err != nil {
			return nil, err
		}
		comment.Website, err = crypto.DecryptAes256(websiteEncrypted, store.aesKey)
		if err != nil {
			return nil, err
		}
		comments = append(comments, comment)
	}
	return comments, nil
}
