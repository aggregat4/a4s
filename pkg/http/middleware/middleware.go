package middleware

import (
	"net/http"
	"net/url"
	"strings"

	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
)

func CsrfMiddleware(next echo.HandlerFunc) echo.HandlerFunc {
	return func(c echo.Context) error {
		// CSRF check unnecessary for GET and HEAD requests as they are safe and idempotent and the Origin header won't be available anyway
		if c.Request().Method == "HEAD" || c.Request().Method == "GET" || c.Request().Method == "OPTIONS" || c.Request().Method == "TRACE" {
			return next(c)
		}
		hostHeader := c.Request().Host
		// parse the target origin from the host header and the X-Forwarded-Host header when present
		hostParts := strings.Split(hostHeader, ":")
		hostName := hostParts[0]
		targetOriginHostname := c.Request().Header.Get("X-Forwarded-Host")
		if targetOriginHostname == "" {
			targetOriginHostname = hostName
		}
		// parse the hostname and the port from the Origin header
		originHeader := c.Request().Header.Get("Origin")
		parsedURL, err := url.Parse(originHeader)
		if err != nil {
			return err
		}
		sourceOriginHostname := parsedURL.Hostname()
		if sourceOriginHostname != targetOriginHostname {
			c.Logger().Info("CSRF check failed: Origin does not match target origin",
				"sourceOriginHostname", sourceOriginHostname,
				"targetOriginHostname", targetOriginHostname)
			return echo.NewHTTPError(http.StatusForbidden, "forbidden")
		}
		return next(c)
	}
}

func CreateCsrfMiddlewareWithSkipper(skipper middleware.Skipper) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			if skipper != nil && skipper(c) {
				return next(c)
			}
			return CsrfMiddleware(next)(c)
		}
	}
}
