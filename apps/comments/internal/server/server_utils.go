package server

import (
	"github.com/labstack/echo/v4"
	"net/http"
)

func sendInternalError(c echo.Context, err error) error {
	logger.Error("Error processing request: ", err)
	return c.Render(http.StatusInternalServerError, "error-internalserver", nil)
}
