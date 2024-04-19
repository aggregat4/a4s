package repository

import (
	"database/sql"
	"fmt"
	"github.com/aggregat4/go-baselib/migrations"
)

type Store struct {
	db *sql.DB
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
