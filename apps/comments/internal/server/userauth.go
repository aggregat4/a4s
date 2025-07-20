package server

import (
	"aggregat4/go-commentservice/internal/domain"
	"net/http"

	"github.com/aggregat4/go-baselib/lang"
	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/labstack/echo-contrib/session"
	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
)

var authenticatedUserCookieName = "commentservice-authenticated-user"

func getUserIdFromSession(c echo.Context) (int, error) {
	sess, err := session.Get(authenticatedUserCookieName, c)
	if err != nil {
		return -1, err
	}
	if sess.Values["userid"] != nil {
		return sess.Values["userid"].(int), nil
	} else {
		return -1, lang.ErrNotFound
	}
}

func getAdminUserIdFromSession(c echo.Context) (string, error) {
	sess, err := session.Get(authenticatedUserCookieName, c)
	if err != nil {
		return "", err
	}
	if sess.Values["adminuserid"] != nil {
		return sess.Values["adminuserid"].(string), nil
	} else {
		return "", lang.ErrNotFound
	}
}

func getAdminRolesFromSession(c echo.Context) ([]string, error) {
	sess, err := session.Get(authenticatedUserCookieName, c)
	if err != nil {
		return nil, err
	}
	if sess.Values["adminroles"] != nil {
		return sess.Values["adminroles"].([]string), nil
	} else {
		return nil, lang.ErrNotFound
	}
}

func getAdminUserFromSession(c echo.Context) (domain.AdminUser, error) {
	adminUserId, err := getAdminUserIdFromSession(c)
	if err != nil {
		return domain.AdminUser{}, err
	}
	
	roles, err := getAdminRolesFromSession(c)
	if err != nil {
		return domain.AdminUser{}, err
	}
	
	return domain.AdminUser{
		UserId: adminUserId,
		Roles:  roles,
	}, nil
}

func createUserSessionCookie(c echo.Context, userId int) error {
	sess, err := session.Get(authenticatedUserCookieName, c)
	if err != nil {
		return err
	}
	sess.Values["userid"] = userId
	return sess.Save(c.Request(), c.Response())
}

func createAdminSessionCookie(c echo.Context, adminUserId string, roles []string) error {
	sess, err := session.Get(authenticatedUserCookieName, c)
	if err != nil {
		return err
	}
	sess.Values["adminuserid"] = adminUserId
	sess.Values["adminroles"] = roles
	err = sess.Save(c.Request(), c.Response())
	if err != nil {
		return sendInternalError(c, err)
	}
	return nil
}

func CreateUserAuthenticationMiddleware(skipper middleware.Skipper) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			if skipper(c) {
				return next(c)
			}
			_, err := getUserIdFromSession(c)
			if err != nil {
				// user is not authenticated, return unauthorized error
				return c.Render(http.StatusUnauthorized, "error-unauthorized", nil)
			} else {
				return next(c)
			}
		}
	}
}

func getUserFromSession(c echo.Context, controller *Controller) (domain.User, error) {
	userId, err := getUserIdFromSession(c)
	if err != nil {
		return domain.User{}, err
	}
	user, err := controller.Store.FindUserById(userId)
	if err != nil {
		return domain.User{}, err
	}
	return user, nil
}

func CreateServiceAdminAuthMiddleware() echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			adminUser, err := getAdminUserFromSession(c)
			if err != nil {
				return c.Render(http.StatusUnauthorized, "error-unauthorized", nil)
			}
			
			serviceKey := c.Param("servicekey")
			if serviceKey == "" {
				return c.Render(http.StatusBadRequest, "error-badrequest", nil)
			}
			
			if !adminUser.HasServiceAdminRole(serviceKey) {
				return c.Render(http.StatusForbidden, "error-forbidden", nil)
			}
			
			return next(c)
		}
	}
}

func CreateSuperAdminAuthMiddleware() echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			adminUser, err := getAdminUserFromSession(c)
			if err != nil {
				return c.Render(http.StatusUnauthorized, "error-unauthorized", nil)
			}
			
			if !adminUser.IsSuperAdmin() {
				return c.Render(http.StatusForbidden, "error-forbidden", nil)
			}
			
			return next(c)
		}
	}
}

func createSessionFromIDToken(c echo.Context, idToken *oidc.IDToken) error {
	var claims struct {
		Subject string   `json:"sub"`
		Roles   []string `json:"roles"`
	}
	
	if err := idToken.Claims(&claims); err != nil {
		return err
	}
	
	// Check if user has any admin roles
	hasAdminRole := false
	for _, role := range claims.Roles {
		if role == "superadmin" || (len(role) > 6 && role[:6] == "admin-") {
			hasAdminRole = true
			break
		}
	}
	
	if hasAdminRole {
		// Create admin session with roles
		return createAdminSessionCookie(c, claims.Subject, claims.Roles)
	} else {
		// TODO: Implement regular user session creation
		// For now, return error since regular users aren't fully implemented
		return c.Render(http.StatusForbidden, "error-forbidden", nil)
	}
}
