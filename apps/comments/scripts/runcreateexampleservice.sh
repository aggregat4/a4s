#!/bin/bash
ENCRYPTION_KEY=$(go run cmd/createencryptionkey/main.go 2>&1)
echo "ENCRYPTION_KEY: $ENCRYPTION_KEY"
go run cmd/createservice/main.go -db ~/tmp/commentservice/commentservice.sqlite -servicekey demoservice -serviceorigin http://localhost:8080 -encryptionkey "$ENCRYPTION_KEY"
