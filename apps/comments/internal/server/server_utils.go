package server

import (
	"aggregat4/go-commentservice/internal/domain"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/labstack/echo/v4"
	"github.com/pkg/errors"
)

func sendInternalError(c echo.Context, err error) error {
	// Wrap the error to capture the stack trace
	wrappedErr := errors.WithStack(err)
	// Log the full error with stack trace
	logger.Error("Internal server error",
		"error", wrappedErr,
		"stack", fmt.Sprintf("%+v", wrappedErr))
	return c.Render(http.StatusInternalServerError, "error-internalserver", domain.ErrorPage{
		BasePage: domain.BasePage{
			Stylesheets: templateStylesheets,
			Scripts:     templateScripts,
		},
	})
}

func csrfMiddleware(next echo.HandlerFunc) echo.HandlerFunc {
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
			logger.Info("CSRF check failed: Origin does not match target origin", "originHostname", originHostname, "targetOriginHostname", targetOriginHostname, "originPort", originPort, "targetOriginPort", targetOriginPort)
			return echo.NewHTTPError(http.StatusForbidden, "forbidden")
		}
		return next(c)
	}
}

func httpResponseLogger(next echo.HandlerFunc) echo.HandlerFunc {
	return func(c echo.Context) error {
		err := next(c)
		if err != nil {
			return err
		}
		for key, values := range c.Response().Header() {
			for _, value := range values {
				logger.Info("Header: %s = %s", key, value)
			}
		}
		return nil
	}
}

func renderErrorPage(c echo.Context, status int, template string) error {
	return c.Render(status, template, domain.ErrorPage{
		BasePage: domain.BasePage{
			Stylesheets: templateStylesheets,
			Scripts:     templateScripts,
		},
	})
}

func renderBadRequest(c echo.Context) error {
	return renderErrorPage(c, http.StatusBadRequest, "error-badrequest")
}

func renderUnauthorized(c echo.Context) error {
	return renderErrorPage(c, http.StatusUnauthorized, "error-unauthorized")
}

func renderNotFound(c echo.Context) error {
	return renderErrorPage(c, http.StatusNotFound, "error-notfound")
}

var ErrIllegalArgument = errors.New("illegal argumen")
