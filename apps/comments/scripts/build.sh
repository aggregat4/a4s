#!/bin/bash
go build -v --tags "fts5" -o bin/gocomments-server cmd/runserver/main.go
go build -v --tags "fts5" -o bin/gocomments-createencryptionkey cmd/createencryptionkey/main.go
