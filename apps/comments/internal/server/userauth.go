package server

import (
	"errors"
	"net/http"

	"aggregat4/go-commentservice/internal/domain"

	baseliboidc "github.com/aggregat4/go-baselib-services/v4/oidc"
	"github.com/aggregat4/go-baselib/lang"
	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/go-chi/chi/v5"
	"github.com/gorilla/sessions"
)

var (
	authenticatedUserCookieName = "commentservice-authenticated-user"
	flashCookieName             = baseliboidc.STDSessionCookieName
)

func (controller *Controller) initializeSessionStores() {
	if controller.sessionStore != nil && controller.flashStore != nil {
		return
	}

	sessionCookieSecretKey := []byte(controller.Config.SessionCookieSecretKey)
	options := &sessions.Options{
		Path:     "/",
		MaxAge:   controller.Config.SessionCookieCookieMaxAge,
		Secure:   controller.Config.SessionCookieSecureFlag,
		HttpOnly: true,
		SameSite: domain.SameSiteFromString(controller.Config.SessionCookieCookieSameSite),
	}

	controller.sessionStore = sessions.NewCookieStore(sessionCookieSecretKey)
	controller.sessionStore.Options = options

	controller.flashStore = sessions.NewCookieStore(sessionCookieSecretKey)
	controller.flashStore.Options = &sessions.Options{
		Path:     options.Path,
		MaxAge:   options.MaxAge,
		Secure:   options.Secure,
		HttpOnly: options.HttpOnly,
		SameSite: options.SameSite,
	}
}

func (controller *Controller) getSession(r *http.Request) (*sessions.Session, error) {
	if controller.sessionStore == nil {
		return nil, errors.New("session store not initialized")
	}
	return controller.sessionStore.Get(r, authenticatedUserCookieName)
}

func (controller *Controller) getFlashSession(r *http.Request) (*sessions.Session, error) {
	if controller.flashStore == nil {
		return nil, errors.New("flash store not initialized")
	}
	return controller.flashStore.Get(r, flashCookieName)
}

func (controller *Controller) getUserIdFromSession(r *http.Request) (int, error) {
	sess, err := controller.getSession(r)
	if err != nil {
		return -1, err
	}
	if value, ok := sess.Values["userid"].(int); ok {
		return value, nil
	}
	return -1, lang.ErrNotFound
}

func (controller *Controller) getAdminUserIdFromSession(r *http.Request) (string, error) {
	sess, err := controller.getSession(r)
	if err != nil {
		return "", err
	}
	if value, ok := sess.Values["adminuserid"].(string); ok {
		return value, nil
	}
	return "", lang.ErrNotFound
}

func (controller *Controller) getAdminRolesFromSession(r *http.Request) ([]string, error) {
	sess, err := controller.getSession(r)
	if err != nil {
		return nil, err
	}
	if value, ok := sess.Values["adminroles"].([]string); ok {
		return value, nil
	}
	return nil, lang.ErrNotFound
}

func (controller *Controller) getAdminUserFromSession(r *http.Request) (domain.AdminUser, error) {
	adminUserId, err := controller.getAdminUserIdFromSession(r)
	if err != nil {
		return domain.AdminUser{}, err
	}

	roles, err := controller.getAdminRolesFromSession(r)
	if err != nil {
		return domain.AdminUser{}, err
	}

	return domain.AdminUser{
		UserId: adminUserId,
		Roles:  roles,
	}, nil
}

func (controller *Controller) createUserSessionCookie(w http.ResponseWriter, r *http.Request, userId int) error {
	sess, err := controller.getSession(r)
	if err != nil {
		return err
	}
	sess.Values["userid"] = userId
	return sess.Save(r, w)
}

func (controller *Controller) createAdminSessionCookie(w http.ResponseWriter, r *http.Request, adminUserId string, roles []string) error {
	sess, err := controller.getSession(r)
	if err != nil {
		return err
	}
	sess.Values["adminuserid"] = adminUserId
	sess.Values["adminroles"] = roles
	return sess.Save(r, w)
}

func (controller *Controller) getUserFromSession(r *http.Request) (domain.User, error) {
	userId, err := controller.getUserIdFromSession(r)
	if err != nil {
		return domain.User{}, err
	}
	user, err := controller.Store.FindUserById(userId)
	if err != nil {
		return domain.User{}, err
	}
	return user, nil
}

func (controller *Controller) serviceAdminAuthMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		adminUser, err := controller.getAdminUserFromSession(r)
		if err != nil {
			controller.renderUnauthorized(w)
			return
		}

		serviceKey := chi.URLParam(r, "servicekey")
		if serviceKey == "" {
			controller.renderBadRequest(w)
			return
		}

		if !adminUser.HasServiceAdminRole(serviceKey) {
			controller.renderForbidden(w)
			return
		}

		next.ServeHTTP(w, r)
	})
}

func (controller *Controller) superAdminAuthMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		adminUser, err := controller.getAdminUserFromSession(r)
		if err != nil {
			controller.renderUnauthorized(w)
			return
		}

		if !adminUser.IsSuperAdmin() {
			controller.renderForbidden(w)
			return
		}

		next.ServeHTTP(w, r)
	})
}

func (controller *Controller) setFlash(w http.ResponseWriter, r *http.Request, key, message string) error {
	sess, err := controller.getFlashSession(r)
	if err != nil {
		return err
	}
	sess.AddFlash(message, key)
	return sess.Save(r, w)
}

func (controller *Controller) getFlashes(w http.ResponseWriter, r *http.Request) ([]string, []string, error) {
	sess, err := controller.getFlashSession(r)
	if err != nil {
		return nil, nil, err
	}

	var successFlashes []string
	for _, flash := range sess.Flashes("success") {
		if msg, ok := flash.(string); ok {
			successFlashes = append(successFlashes, msg)
		}
	}

	var errorFlashes []string
	for _, flash := range sess.Flashes("error") {
		if msg, ok := flash.(string); ok {
			errorFlashes = append(errorFlashes, msg)
		}
	}

	if err := sess.Save(r, w); err != nil {
		return nil, nil, err
	}

	return successFlashes, errorFlashes, nil
}

func createSessionFromIDToken(w http.ResponseWriter, r *http.Request, controller *Controller, idToken *oidc.IDToken) error {
	var claims struct {
		Subject string   `json:"sub"`
		Roles   []string `json:"roles"`
	}

	if err := idToken.Claims(&claims); err != nil {
		return err
	}

	hasAdminRole := false
	for _, role := range claims.Roles {
		if role == "superadmin" || (len(role) > 6 && role[:6] == "admin-") {
			hasAdminRole = true
			break
		}
	}

	if hasAdminRole {
		return controller.createAdminSessionCookie(w, r, claims.Subject, claims.Roles)
	}

	user, err := controller.Store.FindOrCreateUserByExternalId(claims.Subject)
	if err != nil {
		return err
	}
	return controller.createUserSessionCookie(w, r, user.Id)
}
