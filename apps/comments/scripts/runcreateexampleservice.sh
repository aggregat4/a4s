#!/bin/bash
ENCRYPTION_KEY=$(go run cmd/createencryptionkey/main.go 2>&1)
echo "ENCRYPTION_KEY: $ENCRYPTION_KEY"
# echo go run cmd/createservice/main.go -db ~/tmp/commentservice/commentservice.sqlite -servicekey foobar -serviceorigin http://localhost:1234 -encryptionkey $ENCRYPTION_KEY
go run cmd/createservice/main.go -db ~/tmp/commentservice/commentservice.sqlite -servicekey foobar -serviceorigin http://localhost:1234 -encryptionkey "$ENCRYPTION_KEY"
