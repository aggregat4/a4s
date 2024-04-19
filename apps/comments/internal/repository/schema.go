package repository

import "github.com/aggregat4/go-baselib/migrations"

var mymigrations = []migrations.Migration{
	{
		SequenceId: 1,
		Sql: `
		-- Enable WAL mode on the database to allow for concurrent reads and writes
		PRAGMA journal_mode=WAL;
		PRAGMA foreign_keys = ON;

		`,
	},
}
