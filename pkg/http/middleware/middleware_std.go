package middleware

import (
	"log"
	"net/http"
	"net/url"
	"strings"
)

// CsrfMiddlewareStd is a middleware that implements CSRF protection using standard net/http
func CsrfMiddlewareStd(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// CSRF check unnecessary for GET and HEAD requests as they are safe and idempotent
		// and the Origin header won't be available anyway
		if r.Method == "HEAD" || r.Method == "GET" {
			next.ServeHTTP(w, r)
			return
		}

		originHeader := r.Header.Get("Origin")
		hostHeader := r.Host

		// parse the target origin from the host header and the X-Forwarded-Host header when present
		hostParts := strings.Split(hostHeader, ":")
		hostName := hostParts[0]
		targetOriginPort := hostParts[1]
		targetOriginHostname := r.Header.Get("X-Forwarded-Host")
		if targetOriginHostname == "" {
			targetOriginHostname = hostName
		}

		// parse the hostname and the port from the Origin header
		parsedURL, err := url.Parse(originHeader)
		if err != nil {
			log.Printf("CSRF check failed: Invalid Origin header: %v", err)
			http.Error(w, "Forbidden", http.StatusForbidden)
			return
		}

		originHostname := parsedURL.Hostname()
		originPort := "80"
		if parsedURL.Port() != "" {
			originPort = parsedURL.Port()
		}

		if originHostname != targetOriginHostname || originPort != targetOriginPort {
			log.Printf("CSRF check failed: Origin does not match target origin (originHostname=%s, targetOriginHostname=%s, originPort=%s, targetOriginPort=%s)",
				originHostname, targetOriginHostname, originPort, targetOriginPort)
			http.Error(w, "Forbidden", http.StatusForbidden)
			return
		}

		next.ServeHTTP(w, r)
	})
}

// CreateCsrfMiddlewareWithSkipperStd creates a CSRF middleware with a skipper function
func CreateCsrfMiddlewareWithSkipperStd(skipper func(r *http.Request) bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if skipper != nil && skipper(r) {
				next.ServeHTTP(w, r)
				return
			}
			CsrfMiddlewareStd(next).ServeHTTP(w, r)
		})
	}
}
