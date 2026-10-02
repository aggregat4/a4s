package db

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/aggregat4/a4s/pkg/migrations"
	_ "github.com/mattn/go-sqlite3"
	"github.com/microcosm-cc/bluemonday"
)

var mymigrations = []migrations.Migration{
	{
		SequenceId: 1,
		Sql: `
-- Enable WAL mode on the database to allow for concurrent reads and writes
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys = ON;

-- Stores user information, linked to their OIDC identity.
CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    oidc_subject TEXT NOT NULL, -- The 'sub' claim from the OIDC token
    oidc_issuer TEXT NOT NULL,  -- The 'iss' claim from the OIDC token
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(oidc_subject, oidc_issuer)
);

-- Stores the master list of all feed sources.
CREATE TABLE feeds (
    id INTEGER PRIMARY KEY,
    url TEXT NOT NULL UNIQUE,          -- The unique URL of the feed
    title TEXT,                        -- The title of the feed, fetched from the feed itself
    last_fetched_at DATETIME,
    etag TEXT,                         -- HTTP ETag for cache validation
    last_modified TEXT,                -- HTTP Last-Modified header
    cache_until DATETIME,              -- When the cache expires (based on Cache-Control/Expires)
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- A junction table to link users to the feeds they subscribe to.
CREATE TABLE user_feeds (
    user_id INTEGER NOT NULL,
    feed_id INTEGER NOT NULL,
    grid_position INTEGER DEFAULT 0, -- For simple ordering
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(feed_id) REFERENCES feeds(id) ON DELETE CASCADE,
    PRIMARY KEY(user_id, feed_id)
);

-- Stores individual posts/articles from all feeds.
CREATE TABLE posts (
    id INTEGER PRIMARY KEY,
    feed_id INTEGER NOT NULL,
    guid TEXT NOT NULL,          -- Unique identifier from the feed (guid, id, or link)
    title TEXT,
    link TEXT NOT NULL,
    published_at DATETIME,
    content TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(feed_id) REFERENCES feeds(id) ON DELETE CASCADE,
    UNIQUE(feed_id, guid)
);

-- Stores the "seen" state for each user and each post.
CREATE TABLE user_post_states (
    user_id INTEGER NOT NULL,
    post_id INTEGER NOT NULL,
    seen INTEGER NOT NULL DEFAULT 0, -- Using INTEGER 0 for false, 1 for true
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(post_id) REFERENCES posts(id) ON DELETE CASCADE,
    PRIMARY KEY(user_id, post_id)
);
`,
	},
	{
		SequenceId: 2,
		Sql: `
-- Stores user preferences
CREATE TABLE user_preferences (
    user_id INTEGER NOT NULL,
    posts_per_feed INTEGER NOT NULL DEFAULT 10,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY(user_id)
);
`,
	},
	{
		SequenceId: 3,
		Sql: `
ALTER TABLE user_preferences ADD COLUMN columns INTEGER NOT NULL DEFAULT 2;
`,
	},
	{
		SequenceId: 4,
		Sql: `
-- Track feed fetch health so failures can be surfaced to users and backed off.
ALTER TABLE feeds ADD COLUMN last_error TEXT;
ALTER TABLE feeds ADD COLUMN last_error_at DATETIME;
ALTER TABLE feeds ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE feeds ADD COLUMN last_success_at DATETIME;
`,
	},
	{
		SequenceId: 5,
		Sql: `
-- Foreign keys used to be enabled only on the connection that ran the first
-- migration, so ON DELETE CASCADE did not fire on later connections. Clean up
-- the rows that were left behind.
DELETE FROM posts WHERE feed_id NOT IN (SELECT id FROM feeds);
DELETE FROM user_post_states
WHERE post_id NOT IN (SELECT id FROM posts) OR user_id NOT IN (SELECT id FROM users);
DELETE FROM user_feeds
WHERE feed_id NOT IN (SELECT id FROM feeds) OR user_id NOT IN (SELECT id FROM users);
DELETE FROM user_preferences WHERE user_id NOT IN (SELECT id FROM users);
`,
	},
}

// connectionParams are applied by the sqlite3 driver to every connection in
// the pool. PRAGMAs executed through db.Exec only affect a single connection,
// so per-connection settings such as foreign key enforcement must live here.
const connectionParams = "_foreign_keys=on&_journal_mode=WAL&_busy_timeout=5000"

// dsn appends the per-connection parameters to a database path.
func dsn(dbPath string) string {
	sep := "?"
	if strings.Contains(dbPath, "?") {
		sep = "&"
	}
	return dbPath + sep + connectionParams
}

// sanitizer is the HTML policy applied to post content before it is stored.
// Policies are safe for concurrent use and expensive to build, so build once.
var sanitizer = bluemonday.UGCPolicy()

type Store struct {
	db *sql.DB
}

func (store *Store) MoveFeedDown(userID int64, i int64) error {
	// Start a transaction
	tx, err := store.db.Begin()
	if err != nil {
		return fmt.Errorf("error starting transaction: %w", err)
	}
	defer tx.Rollback()

	// Get the current feed's grid position
	var currentPosition int
	err = tx.QueryRow(`
		SELECT grid_position 
		FROM user_feeds 
		WHERE user_id = ? AND feed_id = ?
	`, userID, i).Scan(&currentPosition)
	if err != nil {
		if err == sql.ErrNoRows {
			return fmt.Errorf("feed not found for user")
		}
		return fmt.Errorf("error getting current position: %w", err)
	}

	// Get the next feed's ID and position
	var nextFeedID int64
	var nextPosition int
	err = tx.QueryRow(`
		SELECT feed_id, grid_position 
		FROM user_feeds 
		WHERE user_id = ? AND grid_position > ? 
		ORDER BY grid_position ASC 
		LIMIT 1
	`, userID, currentPosition).Scan(&nextFeedID, &nextPosition)
	if err != nil {
		if err == sql.ErrNoRows {
			return fmt.Errorf("no feed below to move down to")
		}
		return fmt.Errorf("error getting next feed: %w", err)
	}

	// Swap the positions
	_, err = tx.Exec(`
		UPDATE user_feeds 
		SET grid_position = ? 
		WHERE user_id = ? AND feed_id = ?
	`, nextPosition, userID, i)
	if err != nil {
		return fmt.Errorf("error updating current feed position: %w", err)
	}

	_, err = tx.Exec(`
		UPDATE user_feeds 
		SET grid_position = ? 
		WHERE user_id = ? AND feed_id = ?
	`, currentPosition, userID, nextFeedID)
	if err != nil {
		return fmt.Errorf("error updating next feed position: %w", err)
	}

	// Commit the transaction
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("error committing transaction: %w", err)
	}

	return nil
}

func (store *Store) MoveFeedUp(userID int64, i int64) error {
	// Start a transaction
	tx, err := store.db.Begin()
	if err != nil {
		return fmt.Errorf("error starting transaction: %w", err)
	}
	defer tx.Rollback()

	// Get the current feed's grid position
	var currentPosition int
	err = tx.QueryRow(`
		SELECT grid_position 
		FROM user_feeds 
		WHERE user_id = ? AND feed_id = ?
	`, userID, i).Scan(&currentPosition)
	if err != nil {
		if err == sql.ErrNoRows {
			return fmt.Errorf("feed not found for user")
		}
		return fmt.Errorf("error getting current position: %w", err)
	}

	// Get the previous feed's ID and position
	var prevFeedID int64
	var prevPosition int
	err = tx.QueryRow(`
		SELECT feed_id, grid_position 
		FROM user_feeds 
		WHERE user_id = ? AND grid_position < ? 
		ORDER BY grid_position DESC 
		LIMIT 1
	`, userID, currentPosition).Scan(&prevFeedID, &prevPosition)
	if err != nil {
		if err == sql.ErrNoRows {
			return fmt.Errorf("no feed above to move up to")
		}
		return fmt.Errorf("error getting previous feed: %w", err)
	}

	// Swap the positions
	_, err = tx.Exec(`
		UPDATE user_feeds 
		SET grid_position = ? 
		WHERE user_id = ? AND feed_id = ?
	`, prevPosition, userID, i)
	if err != nil {
		return fmt.Errorf("error updating current feed position: %w", err)
	}

	_, err = tx.Exec(`
		UPDATE user_feeds 
		SET grid_position = ? 
		WHERE user_id = ? AND feed_id = ?
	`, currentPosition, userID, prevFeedID)
	if err != nil {
		return fmt.Errorf("error updating previous feed position: %w", err)
	}

	// Commit the transaction
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("error committing transaction: %w", err)
	}

	return nil
}

func NewStore(dbPath string) (*Store, error) {
	store := &Store{}
	if err := store.InitAndVerifyDb(dbPath); err != nil {
		return nil, err
	}
	return store, nil
}

// Close closes the underlying database connection.
func (store *Store) Close() error {
	return store.db.Close()
}

func (store *Store) InitAndVerifyDb(dbPath string) error {
	var err error
	store.db, err = sql.Open("sqlite3", dsn(dbPath))
	if err != nil {
		return fmt.Errorf("error opening database: %w", err)
	}
	return migrations.MigrateSchema(store.db, mymigrations)
}

func (store *Store) GetOrCreateUser(oidcSubject, oidcIssuer string) (int64, error) {
	var userId int64
	err := store.db.QueryRow(
		"SELECT id FROM users WHERE oidc_subject = ? AND oidc_issuer = ?",
		oidcSubject, oidcIssuer,
	).Scan(&userId)

	if err == sql.ErrNoRows {
		result, err := store.db.Exec(
			"INSERT INTO users (oidc_subject, oidc_issuer) VALUES (?, ?)",
			oidcSubject, oidcIssuer,
		)
		if err != nil {
			return 0, fmt.Errorf("error creating user: %w", err)
		}
		userId, err = result.LastInsertId()
		if err != nil {
			return 0, fmt.Errorf("error getting last insert id: %w", err)
		}
	} else if err != nil {
		return 0, fmt.Errorf("error querying user: %w", err)
	}

	return userId, nil
}

func (store *Store) AddFeed(url string) (int64, error) {
	result, err := store.db.Exec(
		"INSERT INTO feeds (url) VALUES (?)",
		url,
	)
	if err != nil {
		return 0, fmt.Errorf("error adding feed: %w", err)
	}
	return result.LastInsertId()
}

// AddFeedForUser adds a feed for a specific user, handling duplicates gracefully
func (store *Store) AddFeedForUser(userId int64, url string) (int64, error) {
	// Start a transaction
	tx, err := store.db.Begin()
	if err != nil {
		return 0, fmt.Errorf("error starting transaction: %w", err)
	}
	defer tx.Rollback()

	// Try to insert the feed, or get existing feed ID if it already exists
	var feedId int64
	err = tx.QueryRow(
		"INSERT INTO feeds (url) VALUES (?) ON CONFLICT(url) DO UPDATE SET url = url RETURNING id",
		url,
	).Scan(&feedId)
	if err != nil {
		return 0, fmt.Errorf("error adding or getting feed: %w", err)
	}

	// Check if the feed is already associated with the user
	var existingPosition int
	err = tx.QueryRow(
		"SELECT grid_position FROM user_feeds WHERE user_id = ? AND feed_id = ?",
		userId, feedId,
	).Scan(&existingPosition)

	if err == sql.ErrNoRows {
		// Feed is not associated with user, add it with the next available position
		var nextPosition int
		err = tx.QueryRow(
			"SELECT COALESCE(MAX(grid_position), -1) + 1 FROM user_feeds WHERE user_id = ?",
			userId,
		).Scan(&nextPosition)
		if err != nil {
			return 0, fmt.Errorf("error getting next position: %w", err)
		}

		_, err = tx.Exec(
			"INSERT INTO user_feeds (user_id, feed_id, grid_position) VALUES (?, ?, ?)",
			userId, feedId, nextPosition,
		)
		if err != nil {
			return 0, fmt.Errorf("error associating feed with user: %w", err)
		}
	} else if err != nil {
		return 0, fmt.Errorf("error checking existing feed association: %w", err)
	}
	// If feed is already associated, do nothing (return existing feedId)

	// Commit the transaction
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("error committing transaction: %w", err)
	}

	return feedId, nil
}

func (store *Store) GetUserFeeds(userId int64) ([]Feed, error) {
	rows, err := store.db.Query(`
		SELECT `+feedColumns+`, uf.grid_position
		FROM feeds f
		JOIN user_feeds uf ON f.id = uf.feed_id
		WHERE uf.user_id = ?
		ORDER BY uf.grid_position ASC
	`, userId)
	if err != nil {
		return nil, fmt.Errorf("error querying user feeds: %w", err)
	}
	defer rows.Close()

	var feeds []Feed
	for rows.Next() {
		var gridPosition int
		f, err := scanFeed(rows, &gridPosition)
		if err != nil {
			return nil, err
		}
		f.GridPosition = gridPosition
		feeds = append(feeds, f)
	}
	return feeds, rows.Err()
}

// feedColumns lists the feeds columns read by scanFeed, in scan order. Queries
// must alias the feeds table as f.
const feedColumns = `f.id, f.url, f.title, f.last_fetched_at, f.etag, f.last_modified, f.cache_until,
	f.last_error, f.last_error_at, f.consecutive_failures, f.last_success_at`

// rowScanner is implemented by *sql.Row and *sql.Rows.
type rowScanner interface {
	Scan(dest ...any) error
}

// scanFeed scans a row selected with feedColumns into a Feed, mapping NULL
// columns to zero values. Additional destinations for columns selected after
// feedColumns can be passed as extra.
func scanFeed(row rowScanner, extra ...any) (Feed, error) {
	var f Feed
	var title, etag, lastModified, lastError sql.NullString
	var lastFetched, cacheUntil, lastErrorAt, lastSuccessAt sql.NullTime
	dest := append([]any{
		&f.ID, &f.URL, &title, &lastFetched, &etag, &lastModified, &cacheUntil,
		&lastError, &lastErrorAt, &f.ConsecutiveFailures, &lastSuccessAt,
	}, extra...)
	if err := row.Scan(dest...); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Feed{}, err
		}
		return Feed{}, fmt.Errorf("error scanning feed: %w", err)
	}
	f.Title = title.String
	f.ETag = etag.String
	f.LastModified = lastModified.String
	f.LastError = lastError.String
	f.LastFetchedAt = lastFetched.Time
	f.CacheUntil = cacheUntil.Time
	f.LastErrorAt = lastErrorAt.Time
	f.LastSuccessAt = lastSuccessAt.Time
	return f, nil
}

type Feed struct {
	ID                  int64
	URL                 string
	Title               string
	LastFetchedAt       time.Time
	ETag                string
	LastModified        string
	CacheUntil          time.Time
	GridPosition        int
	LastError           string
	LastErrorAt         time.Time
	ConsecutiveFailures int
	LastSuccessAt       time.Time
}

// AddPost adds a post to the database, ignoring posts that already exist. See
// InsertPost.
func (store *Store) AddPost(feedId int64, guid, title, link string, publishedAt time.Time, content string) error {
	_, err := store.InsertPost(feedId, guid, title, link, publishedAt, content)
	return err
}

// InsertPost adds a post to the database after sanitizing its content with the
// bluemonday UGC policy. Posts whose (feed, guid) already exists are left
// untouched. It reports whether a new row was inserted.
func (store *Store) InsertPost(feedId int64, guid, title, link string, publishedAt time.Time, content string) (bool, error) {
	res, err := store.db.Exec(`
		INSERT OR IGNORE INTO posts (feed_id, guid, title, link, published_at, content)
		VALUES (?, ?, ?, ?, ?, ?)
	`, feedId, guid, title, link, publishedAt, sanitizer.Sanitize(content))
	if err != nil {
		return false, fmt.Errorf("error adding post: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("error getting rows affected: %w", err)
	}
	return n > 0, nil
}

// PruneFeedPosts deletes old posts for a feed, keeping only the most recent
// `keep` posts by published date. Posts whose GUID is listed in keepGUIDs are
// never deleted: these are the items still present in the feed document, and
// deleting them would cause them to be re-inserted (as unread) on the next
// fetch.
func (store *Store) PruneFeedPosts(feedId int64, keep int, keepGUIDs ...string) error {
	if keepGUIDs == nil {
		keepGUIDs = []string{}
	}
	protected, err := json.Marshal(keepGUIDs)
	if err != nil {
		return fmt.Errorf("error encoding protected guids: %w", err)
	}
	_, err = store.db.Exec(`
		DELETE FROM posts
		WHERE id IN (
			SELECT id FROM posts
			WHERE feed_id = ?
			ORDER BY published_at DESC, id DESC
			LIMIT -1 OFFSET ?
		)
		AND guid NOT IN (SELECT value FROM json_each(?))
	`, feedId, keep, string(protected))
	if err != nil {
		return fmt.Errorf("error pruning feed posts: %w", err)
	}
	return nil
}

// GetFeedPosts gets the posts for a given feed and user, and returns them in descending order of published_at
func (store *Store) GetFeedPosts(feedId int64, userId int64, limit int) ([]Post, error) {
	rows, err := store.db.Query(`
		SELECT p.id, p.title, p.link, p.published_at, p.content,
		       COALESCE(ups.seen, 0) as seen
		FROM posts p
		LEFT JOIN user_post_states ups ON p.id = ups.post_id AND ups.user_id = ?
		WHERE p.feed_id = ?
		ORDER BY p.published_at DESC
		LIMIT ?
	`, userId, feedId, limit)
	if err != nil {
		return nil, fmt.Errorf("error querying feed posts: %w", err)
	}
	defer rows.Close()

	var posts []Post
	for rows.Next() {
		var p Post
		err := rows.Scan(&p.ID, &p.Title, &p.Link, &p.PublishedAt, &p.Content, &p.Seen)
		if err != nil {
			return nil, fmt.Errorf("error scanning post: %w", err)
		}
		posts = append(posts, p)
	}
	return posts, nil
}

type Post struct {
	ID          int64
	Title       string
	Link        string
	PublishedAt time.Time
	Content     string
	Seen        bool
}

// MarkPostAsSeenForUser marks a post as seen for a given user, but only if the
// post belongs to one of the user's subscribed feeds. It returns sql.ErrNoRows
// when the post is not accessible to the user.
func (store *Store) MarkPostAsSeenForUser(userID, postID int64) error {
	res, err := store.db.Exec(`
		INSERT INTO user_post_states (user_id, post_id, seen)
		SELECT ?, p.id, 1
		FROM posts p
		JOIN user_feeds uf ON uf.feed_id = p.feed_id AND uf.user_id = ?
		WHERE p.id = ?
		ON CONFLICT(user_id, post_id) DO UPDATE SET seen = 1
	`, userID, userID, postID)
	if err != nil {
		return fmt.Errorf("error marking post as seen for user: %w", err)
	}
	rows, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("error getting rows affected: %w", err)
	}
	if rows == 0 {
		return sql.ErrNoRows
	}
	return nil
}

// MarkAllFeedPostsAsSeenForUser marks all posts in a feed as seen for a given
// user, but only if the user is subscribed to the feed. It returns
// sql.ErrNoRows when the user is not subscribed to the feed.
func (store *Store) MarkAllFeedPostsAsSeenForUser(userID, feedID int64) error {
	var subscribed int
	err := store.db.QueryRow(
		"SELECT COUNT(*) FROM user_feeds WHERE user_id = ? AND feed_id = ?",
		userID, feedID,
	).Scan(&subscribed)
	if err != nil {
		return fmt.Errorf("error checking feed subscription: %w", err)
	}
	if subscribed == 0 {
		return sql.ErrNoRows
	}

	_, err = store.db.Exec(`
		INSERT INTO user_post_states (user_id, post_id, seen)
		SELECT ?, p.id, 1
		FROM posts p
		WHERE p.feed_id = ?
		ON CONFLICT(user_id, post_id) DO UPDATE SET seen = 1
	`, userID, feedID)
	if err != nil {
		return fmt.Errorf("error marking all feed posts as seen for user: %w", err)
	}
	return nil
}

func (store *Store) GetAllFeeds() ([]Feed, error) {
	rows, err := store.db.Query(`SELECT ` + feedColumns + ` FROM feeds f`)
	if err != nil {
		return nil, fmt.Errorf("error querying feeds: %w", err)
	}
	defer rows.Close()

	var feeds []Feed
	for rows.Next() {
		f, err := scanFeed(rows)
		if err != nil {
			return nil, err
		}
		feeds = append(feeds, f)
	}
	return feeds, rows.Err()
}

func (store *Store) UpdateFeedTitle(feedId int64, title string) error {
	_, err := store.db.Exec(`
		UPDATE feeds
		SET title = ?
		WHERE id = ?
	`, title, feedId)
	if err != nil {
		return fmt.Errorf("error updating feed title: %w", err)
	}
	return nil
}

func (store *Store) UpdateFeedLastFetched(feedId int64, timestamp time.Time) error {
	_, err := store.db.Exec(`
		UPDATE feeds
		SET last_fetched_at = ?
		WHERE id = ?
	`, timestamp, feedId)
	if err != nil {
		return fmt.Errorf("error updating feed last fetched: %w", err)
	}
	return nil
}

// RecordFeedFailure records a fetch failure on the feed: it increments
// consecutive_failures and stores the error message and timestamp.
func (store *Store) RecordFeedFailure(feedID int64, fetchErr error, at time.Time) error {
	_, err := store.db.Exec(`
		UPDATE feeds
		SET last_error = ?, last_error_at = ?, consecutive_failures = consecutive_failures + 1
		WHERE id = ?
	`, fetchErr.Error(), at, feedID)
	if err != nil {
		return fmt.Errorf("error recording feed failure: %w", err)
	}
	return nil
}

// RecordFeedSuccess clears any failure state and records the time of a
// successful fetch, resetting consecutive_failures to 0.
func (store *Store) RecordFeedSuccess(feedID int64, at time.Time) error {
	_, err := store.db.Exec(`
		UPDATE feeds
		SET last_error = NULL, last_error_at = NULL, consecutive_failures = 0, last_success_at = ?
		WHERE id = ?
	`, at, feedID)
	if err != nil {
		return fmt.Errorf("error recording feed success: %w", err)
	}
	return nil
}

// DeleteFeedForUser removes a user's subscription to a feed. If no users
// remain subscribed, the feed row (and its posts, via cascade) is deleted as
// well. It returns sql.ErrNoRows when the user is not subscribed to the feed.
func (store *Store) DeleteFeedForUser(userID, feedID int64) error {
	tx, err := store.db.Begin()
	if err != nil {
		return fmt.Errorf("error starting transaction: %w", err)
	}
	defer tx.Rollback()

	res, err := tx.Exec(
		"DELETE FROM user_feeds WHERE user_id = ? AND feed_id = ?",
		userID, feedID,
	)
	if err != nil {
		return fmt.Errorf("error deleting user feed subscription: %w", err)
	}
	rows, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("error getting rows affected: %w", err)
	}
	if rows == 0 {
		return sql.ErrNoRows
	}

	// Garbage-collect the feed row when no subscribers remain.
	if _, err := tx.Exec(`
		DELETE FROM feeds
		WHERE id = ? AND NOT EXISTS (
			SELECT 1 FROM user_feeds WHERE feed_id = ?
		)
	`, feedID, feedID); err != nil {
		return fmt.Errorf("error garbage-collecting orphaned feed: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("error committing transaction: %w", err)
	}
	return nil
}

func (store *Store) UpdateFeedCacheInfo(feedId int64, etag, lastModified string, cacheUntil time.Time) error {
	_, err := store.db.Exec(`
		UPDATE feeds
		SET etag = ?, last_modified = ?, cache_until = ?
		WHERE id = ?
	`, etag, lastModified, cacheUntil, feedId)
	if err != nil {
		return fmt.Errorf("error updating feed cache info: %w", err)
	}
	return nil
}

// GetFeedByURL returns the feed with the given URL, or nil when it does not
// exist.
func (store *Store) GetFeedByURL(url string) (*Feed, error) {
	row := store.db.QueryRow(`SELECT `+feedColumns+` FROM feeds f WHERE f.url = ?`, url)
	f, err := scanFeed(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &f, nil
}

// GetUserPostsPerFeed gets the number of posts per feed for a user
func (store *Store) GetUserPostsPerFeed(userId int64) (int, error) {
	var postsPerFeed int
	err := store.db.QueryRow(`
		SELECT posts_per_feed 
		FROM user_preferences 
		WHERE user_id = ?
	`, userId).Scan(&postsPerFeed)

	if err == sql.ErrNoRows {
		// Return default value if no preference is set
		return 10, nil
	}
	if err != nil {
		return 0, fmt.Errorf("error querying user posts per feed preference: %w", err)
	}

	return postsPerFeed, nil
}

// SetUserPostsPerFeed sets the number of posts per feed for a user
func (store *Store) SetUserPostsPerFeed(userId int64, postsPerFeed int) error {
	_, err := store.db.Exec(`
		INSERT INTO user_preferences (user_id, posts_per_feed) 
		VALUES (?, ?) 
		ON CONFLICT(user_id) DO UPDATE SET posts_per_feed = ?
	`, userId, postsPerFeed, postsPerFeed)
	if err != nil {
		return fmt.Errorf("error setting user posts per feed preference: %w", err)
	}
	return nil
}

// SetUserPreferences stores both display preferences for a user in a single
// statement.
func (store *Store) SetUserPreferences(userId int64, postsPerFeed, columns int) error {
	_, err := store.db.Exec(`
		INSERT INTO user_preferences (user_id, posts_per_feed, columns)
		VALUES (?, ?, ?)
		ON CONFLICT(user_id) DO UPDATE SET posts_per_feed = excluded.posts_per_feed, columns = excluded.columns
	`, userId, postsPerFeed, columns)
	if err != nil {
		return fmt.Errorf("error setting user preferences: %w", err)
	}
	return nil
}

// GetPostForUser retrieves a single post by its ID, but only if the post's feed
// is subscribed to by the given user. It returns sql.ErrNoRows when the post
// does not exist or the user has no subscription to its feed.
func (store *Store) GetPostForUser(userID, postID int64) (*Post, error) {
	var p Post
	err := store.db.QueryRow(`
		SELECT p.id, p.title, p.link, p.published_at, p.content
		FROM posts p
		JOIN user_feeds uf ON uf.feed_id = p.feed_id AND uf.user_id = ?
		WHERE p.id = ?
	`, userID, postID).Scan(&p.ID, &p.Title, &p.Link, &p.PublishedAt, &p.Content)
	if err == sql.ErrNoRows {
		return nil, sql.ErrNoRows
	}
	if err != nil {
		return nil, fmt.Errorf("error querying post for user: %w", err)
	}
	return &p, nil
}

// GetUserColumns gets the number of columns for a user
func (store *Store) GetUserColumns(userId int64) (int, error) {
	var columns int
	err := store.db.QueryRow(`
		SELECT columns 
		FROM user_preferences 
		WHERE user_id = ?
	`, userId).Scan(&columns)

	if err == sql.ErrNoRows {
		// Return default value if no preference is set
		return 2, nil
	}
	if err != nil {
		return 0, fmt.Errorf("error querying user columns preference: %w", err)
	}

	return columns, nil
}

// SetUserColumns sets the number of columns for a user
func (store *Store) SetUserColumns(userId int64, columns int) error {
	_, err := store.db.Exec(`
		INSERT INTO user_preferences (user_id, columns) 
		VALUES (?, ?) 
		ON CONFLICT(user_id) DO UPDATE SET columns = ?
	`, userId, columns, columns)
	if err != nil {
		return fmt.Errorf("error setting user columns preference: %w", err)
	}
	return nil
}
