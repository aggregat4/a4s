package server

import (
	"aggregat4/go-commentservice/internal/domain"
	"fmt"
	"net/http"

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
