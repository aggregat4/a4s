package repository

import "github.com/aggregat4/go-baselib/migrations"

var mymigrations = []migrations.Migration{
	{
		SequenceId: 1,
		Sql: `
		-- Enable WAL mode on the database to allow for concurrent reads and writes
		PRAGMA journal_mode=WAL;
		PRAGMA foreign_keys=ON;
		
		CREATE TABLE IF NOT EXISTS users (
			id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
			email_encrypted LOB NOT NULL,
			auth_token TEXT,
			auth_token_created_at TIMESTAMP,
			auth_token_sent_to_client INTEGER NOT NULL,
    	);

		CREATE TABLE IF NOT EXISTS services (
			id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
			service_key TEXT NOT NULL,
    		origin TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS comments (
			id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
			service_id INTEGER NOT NULL,
			user_id INTEGER NOT NULL,
			post_key TEXT NOT NULL,
			comment_encrypted LOB NOT NULL,
			name_encrypted LOB,
			website_encrypted LOB,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    		FOREIGN KEY(service_id) REFERENCES services(id) ON DELETE CASCADE,
    		FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
		);
		`,
	},
}
