# Changelog

All notable changes to Delicious Bookmarks are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Release notes for a tag are taken from the matching version section, so the
`Unreleased` section is renamed to the release version when a release is cut.

## [Unreleased]

## [v1.2.1] - 2026-11-01

### Security

- Built with Go 1.27.3, which distrusts compromised intermediate
  certificates in `crypto/x509` (GO-2026-6809).
- Upgraded `golang.org/x/net` to v0.62.0, fixing unsafe HTML rendering of
  raw text (GO-2026-6866) and quadratic parsing time on crafted pages
  (GO-2026-6860) when crawling bookmarked pages.
