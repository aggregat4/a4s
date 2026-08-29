// Package echomiddleware contains Bookmarks' Echo-specific HTTP middleware.
package echomiddleware

import (
	"net/http"
	"net/url"
	"strings"

	"github.com/labstack/echo/v4"
	echoMiddleware "github.com/labstack/echo/v4/middleware"
)

// CsrfMiddleware implements the Echo CSRF behavior used by Bookmarks.
func CsrfMiddleware(next echo.HandlerFunc) echo.HandlerFunc {
	return func(c echo.Context) error {
		if c.Request().Method == http.MethodHead || c.Request().Method == http.MethodGet || c.Request().Method == http.MethodOptions || c.Request().Method == http.MethodTrace {
			return next(c)
		}
		hostName := strings.Split(c.Request().Host, ":")[0]
		targetOriginHostname := c.Request().Header.Get("X-Forwarded-Host")
		if targetOriginHostname == "" {
			targetOriginHostname = hostName
		}
		parsedURL, err := url.Parse(c.Request().Header.Get("Origin"))
		if err != nil {
			return err
		}
		if parsedURL.Hostname() != targetOriginHostname {
			c.Logger().Info("CSRF check failed: Origin does not match target origin", "sourceOriginHostname", parsedURL.Hostname(), "targetOriginHostname", targetOriginHostname)
			return echo.NewHTTPError(http.StatusForbidden, "forbidden")
		}
		return next(c)
	}
}

// CreateCsrfMiddlewareWithSkipper returns Echo CSRF middleware with a skipper.
func CreateCsrfMiddlewareWithSkipper(skipper echoMiddleware.Skipper) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			if skipper != nil && skipper(c) {
				return next(c)
			}
			return CsrfMiddleware(next)(c)
		}
	}
}
