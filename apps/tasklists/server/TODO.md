# Server TODO

- Add OIDC authentication: userid is the key to split in the schema
- Add compaction that prunes ops once all known clients have advanced past a safe server sequence. This is only sensibly possible once we have snapshotting as a way for clients to join after compaction has run on the log and still get all the data.
