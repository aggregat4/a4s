.PHONY: build fmt fmt-check imports imports-check vet staticcheck golangci-lint lint lint-full modernize test ci ci-full fix

# Build targets
build:
	go build ./...

# Formatting with standard gofmt
fmt:
	gofmt -w .

fmt-check:
	@unformatted=$$(gofmt -l .); \
	if [ -n "$$unformatted" ]; then \
		echo "gofmt needed for:"; \
		echo "$$unformatted"; \
		exit 1; \
	fi

# Import formatting - organizes imports into stdlib vs third-party groups
imports:
	goimports -w .

imports-check:
	@unformatted=$$(goimports -l .); \
	if [ -n "$$unformatted" ]; then \
		echo "goimports needed for:"; \
		echo "$$unformatted"; \
		exit 1; \
	fi

# Linting targets
vet:
	go vet ./...

staticcheck:
	staticcheck ./...

golangci-lint:
	golangci-lint run ./...

# Basic lint (fmt + vet)
lint: fmt-check vet

# Full lint (includes all linters)
lint-full: fmt-check imports-check vet staticcheck golangci-lint

# Modernize code to use newer Go features
modernize:
	modernize ./...

modernize-check:
	@output=$$(modernize ./... 2>&1); \
	if [ -n "$$output" ]; then \
		echo "modernize suggestions:"; \
		echo "$$output"; \
		exit 1; \
	fi

# Test targets
test:
	go test ./...

test-race:
	go test -race ./...

test-cover:
	go test -cover ./...

# CI targets
ci:
	GOCACHE=/tmp/go-build go build ./...
	GOCACHE=/tmp/go-build go vet ./...
	GOCACHE=/tmp/go-build go test ./...

# Full CI with all linting and modernizing
ci-full:
	$(MAKE) fmt-check
	$(MAKE) imports-check
	GOCACHE=/tmp/go-build go build ./...
	GOCACHE=/tmp/go-build go vet ./...
	staticcheck ./...
	golangci-lint run ./...
	modernize ./...
	GOCACHE=/tmp/go-build go test -race ./...

# Fix all auto-fixable issues
fix: fmt imports
	@echo "Fixed all auto-fixable formatting and import issues"
