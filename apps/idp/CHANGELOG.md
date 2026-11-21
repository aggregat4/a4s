# Changelog

All notable changes to the OpenID Provider are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Release notes for a tag are taken from the matching version section, so the
`Unreleased` section is renamed to the release version when a release is cut.

## [Unreleased]

## [v2.2.2] - 2026-11-21

### Security

- Cross-origin form posts are rejected with Go's `http.CrossOriginProtection`,
  which uses the browser's `Sec-Fetch-Site` header and otherwise compares
  `Origin` with `Host`, including the port. The token and revocation
  endpoints stay open to relying parties' servers. A post from another port
  on the same host is now rejected, and the client-controlled
  `X-Forwarded-Host` header is no longer trusted.
- Built with Go 1.27.4, which fixes an HTTP/1 server crash caused by a race
  in `net/http` (GO-2026-6859).

## [v2.2.1] - 2026-11-01

### Security

- Built with Go 1.27.3, which distrusts compromised intermediate
  certificates in `crypto/x509` (GO-2026-6809).
