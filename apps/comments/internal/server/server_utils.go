package server

import (
	"aggregat4/go-commentservice/internal/domain"
	"bytes"
	"net/http"

	"github.com/aggregat4/go-baselib/lang"
	"github.com/pkg/errors"
)

func (controller *Controller) buildAuthContext(r *http.Request) domain.AuthContext {
	var auth domain.AuthContext

	if user, err := controller.getUserFromSession(r); err == nil {
		u := user
		auth.User = &u
	} else if err != nil && !errors.Is(err, lang.ErrNotFound) {
		logger.Error("Failed to resolve user for auth context: {err}", err)
	}

	if adminUser, err := controller.getAdminUserFromSession(r); err == nil {
		a := adminUser
		auth.AdminUser = &a
		auth.IsAdmin = true
		auth.IsSuperAdmin = a.IsSuperAdmin()
	} else if err != nil && !errors.Is(err, lang.ErrNotFound) {
		logger.Error("Failed to resolve admin user for auth context: {err}", err)
	}

	return auth
}

func (controller *Controller) basePage(r *http.Request) domain.BasePage {
	base := domain.BasePage{
		Stylesheets: templateStylesheets,
		Scripts:     templateScripts,
		Auth:        controller.buildAuthContext(r),
	}

	if r != nil && r.URL != nil {
		base.CurrentPath = r.URL.RequestURI()
	}

	return base
}

func (controller *Controller) sendInternalError(w http.ResponseWriter, r *http.Request, err error) {
	logger.Error("Internal server error: {err}", err)
	controller.renderTemplate(w, r, http.StatusInternalServerError, "error-internalserver", domain.ErrorPage{
		BasePage: controller.basePage(r),
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

func (controller *Controller) renderTemplate(w http.ResponseWriter, r *http.Request, status int, template string, data any) {
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

func (controller *Controller) renderErrorPage(w http.ResponseWriter, r *http.Request, status int, template string) {
	controller.renderTemplate(w, r, status, template, domain.ErrorPage{
		BasePage: controller.basePage(r),
	})
}

func (controller *Controller) renderBadRequest(w http.ResponseWriter, r *http.Request) {
	controller.renderErrorPage(w, r, http.StatusBadRequest, "error-badrequest")
}

func (controller *Controller) renderUnauthorized(w http.ResponseWriter, r *http.Request) {
	controller.renderErrorPage(w, r, http.StatusUnauthorized, "error-unauthorized")
}

func (controller *Controller) renderNotFound(w http.ResponseWriter, r *http.Request) {
	controller.renderErrorPage(w, r, http.StatusNotFound, "error-notfound")
}

func (controller *Controller) renderForbidden(w http.ResponseWriter, r *http.Request) {
	controller.renderErrorPage(w, r, http.StatusForbidden, "error-forbidden")
}

func (controller *Controller) handleCommonErrors(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, lang.ErrNotFound) {
		controller.renderNotFound(w, r)
		return
	}
	if errors.Is(err, ErrIllegalArgument) {
		controller.renderBadRequest(w, r)
		return
	}
	controller.sendInternalError(w, r, err)
}

var ErrIllegalArgument = errors.New("illegal argument")
