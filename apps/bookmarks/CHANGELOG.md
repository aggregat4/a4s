# Changelog

All notable changes to Delicious Bookmarks are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Release notes for a tag are taken from the matching version section, so the
`Unreleased` section is renamed to the release version when a release is cut.

## [Unreleased]

### Changed

- The server runs on the Go standard library instead of the Echo framework.
  Echo v4 has known vulnerabilities without a fix (GO-2026-6875,
  GO-2026-6872); Bookmarks did not use the affected parts, but no longer
  depends on Echo at all. Logins stay valid across the upgrade.
- A failed login shows a plain "Unauthorized" message instead of an error
  page, and opening the app in several tabs while logged out no longer
  makes the logins in the other tabs fail.
- Cross-origin form posts are rejected with Go's `http.CrossOriginProtection`,
  which uses the browser's `Sec-Fetch-Site` header and otherwise compares
  `Origin` with `Host`, including the port. A post from another port on the
  same host is now rejected, and the client-controlled `X-Forwarded-Host`
  header is no longer trusted.

### Fixed

- Saving a bookmark without an address answers 400 with a message instead
  of a server error, and other errors show the error page again instead of a
  bare message.

### Security

- Built with Go 1.27.4, which fixes an HTTP/1 server crash caused by a race
  in `net/http` (GO-2026-6859).

## [v1.2.1] - 2026-11-01

### Security

- Built with Go 1.27.3, which distrusts compromised intermediate
  certificates in `crypto/x509` (GO-2026-6809).
- Upgraded `golang.org/x/net` to v0.62.0, fixing unsafe HTML rendering of
  raw text (GO-2026-6866) and quadratic parsing time on crafted pages
  (GO-2026-6860) when crawling bookmarked pages.
