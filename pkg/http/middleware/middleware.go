package middleware

import (
	"net/http"
	"net/url"
	"strings"

	"github.com/labstack/echo/v4"
)

func CsrfMiddleware(next echo.HandlerFunc) echo.HandlerFunc {
	return func(c echo.Context) error {
		// CSRF check unnecessary for GET and HEAD requests as they are safe and idempotent and the Origin header won't be available anyway
		if c.Request().Method == "HEAD" || c.Request().Method == "GET" {
			return next(c)
		}
		originHeader := c.Request().Header.Get("Origin")
		hostHeader := c.Request().Host
		// parse the target origin from the host header and the X-Forwarded-Host header when present
		hostParts := strings.Split(hostHeader, ":")
		hostName := hostParts[0]
		targetOriginPort := hostParts[1]
		targetOriginHostname := c.Request().Header.Get("X-Forwarded-Host")
		if targetOriginHostname == "" {
			targetOriginHostname = hostName
		}
		// parse the hostname and the port from the Origin header
		parsedURL, err := url.Parse(originHeader)
		if err != nil {
			return err
		}
		originHostname := parsedURL.Hostname()
		originPort := "80"
		if parsedURL.Port() != "" {
			originPort = parsedURL.Port()
		}
		if originHostname != targetOriginHostname || originPort != targetOriginPort {
			c.Logger().Info("CSRF check failed: Origin does not match target origin",
				"originHostname", originHostname,
				"targetOriginHostname", targetOriginHostname,
				"originPort", originPort,
				"targetOriginPort", targetOriginPort)
			return echo.NewHTTPError(http.StatusForbidden, "forbidden")
		}
		return next(c)
	}
}
