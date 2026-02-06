# Server TODO

- Future: introduce a users table with integer surrogate ids to avoid storing user_id text on every row.
- Add compaction that prunes ops once all known clients have advanced past a safe server sequence. This is only sensibly possible once we have snapshotting as a way for clients to join after compaction has run on the log and still get all the data.
