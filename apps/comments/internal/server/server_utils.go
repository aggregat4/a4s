package server

import (
	"net/http"

	"github.com/labstack/echo/v4"
)

func sendInternalError(c echo.Context, err error) error {
	logger.Error("Error processing request", "error", err)
	return c.Render(http.StatusInternalServerError, "error-internalserver", nil)
}
