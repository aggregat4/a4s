.PHONY: build fmt fmt-check lint test ci

build:
	go build ./...

fmt:
	gofmt -w .

fmt-check:
	@unformatted=$$(gofmt -l .); \
	if [ -n "$$unformatted" ]; then \
		echo "gofmt needed for:"; \
		echo "$$unformatted"; \
		exit 1; \
	fi

lint: fmt-check
	go vet ./...

test:
	go test ./...

ci:
	GOCACHE=/tmp/go-build go build ./...
	GOCACHE=/tmp/go-build go vet ./...
	GOCACHE=/tmp/go-build go test ./...
