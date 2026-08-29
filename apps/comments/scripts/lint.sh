#!/bin/bash
echo Running golanci-lint
"$(go env GOPATH)"/bin/golangci-lint run
echo Running modernize
go run golang.org/x/tools/gopls/internal/analysis/modernize/cmd/modernize@latest  -v -test ./...
