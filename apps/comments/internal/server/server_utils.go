package server

import (
	"aggregat4/go-commentservice/internal/domain"
	"bytes"
	"net/http"

	"github.com/aggregat4/go-baselib/lang"
	"github.com/pkg/errors"
)

func (controller *Controller) sendInternalError(w http.ResponseWriter, err error) {
	logger.Error("Internal server error: {err}", err)
	controller.renderTemplate(w, http.StatusInternalServerError, "error-internalserver", domain.ErrorPage{
		BasePage: domain.BasePage{
			Stylesheets: templateStylesheets,
			Scripts:     templateScripts,
		},
	})
}

func httpResponseLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r)
		for key, values := range w.Header() {
			for _, value := range values {
				logger.Info("Header {HeaderKey} = {HeaderValue}", key, value)
			}
		}
	})
}

func (controller *Controller) renderTemplate(w http.ResponseWriter, status int, template string, data any) {
	if controller.renderer == nil {
		logger.Error("Template renderer not configured")
		http.Error(w, http.StatusText(http.StatusInternalServerError), http.StatusInternalServerError)
		return
	}
	var buffer bytes.Buffer
	if err := controller.renderer.Render(&buffer, template, data); err != nil {
		logger.Error("Failed to render template {template}: {err}", template, err)
		http.Error(w, http.StatusText(http.StatusInternalServerError), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	if _, err := buffer.WriteTo(w); err != nil {
		logger.Error("Failed to write response for template {template}: {err}", template, err)
	}
}

func (controller *Controller) renderErrorPage(w http.ResponseWriter, status int, template string) {
	controller.renderTemplate(w, status, template, domain.ErrorPage{
		BasePage: domain.BasePage{
			Stylesheets: templateStylesheets,
			Scripts:     templateScripts,
		},
	})
}

func (controller *Controller) renderBadRequest(w http.ResponseWriter) {
	controller.renderErrorPage(w, http.StatusBadRequest, "error-badrequest")
}

func (controller *Controller) renderUnauthorized(w http.ResponseWriter) {
	controller.renderErrorPage(w, http.StatusUnauthorized, "error-unauthorized")
}

func (controller *Controller) renderNotFound(w http.ResponseWriter) {
	controller.renderErrorPage(w, http.StatusNotFound, "error-notfound")
}

func (controller *Controller) renderForbidden(w http.ResponseWriter) {
	controller.renderErrorPage(w, http.StatusForbidden, "error-forbidden")
}

func (controller *Controller) handleCommonErrors(w http.ResponseWriter, err error) {
	if errors.Is(err, lang.ErrNotFound) {
		controller.renderNotFound(w)
		return
	}
	if errors.Is(err, ErrIllegalArgument) {
		controller.renderBadRequest(w)
		return
	}
	controller.sendInternalError(w, err)
}

var ErrIllegalArgument = errors.New("illegal argument")
