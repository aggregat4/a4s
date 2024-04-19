package oidc

import (
	"encoding/base64"
	"errors"
	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/labstack/echo-contrib/session"
	"github.com/labstack/echo/v4"
	"log"
	"net/http"
	"strings"
	"time"
)

var sessionCookieName = "baselib-oidc-session-cookie"

func GetUserIdFromSession(c echo.Context) (int, error) {
	sess, err := session.Get(sessionCookieName, c)
	if err != nil {
		return 0, err
	}
	if sess.Values["userid"] != nil {
		return sess.Values["userid"].(int), nil
	} else {
		return 0, errors.New("no userid in session")
	}
}

func clearSessionCookie(c echo.Context) {
	c.SetCookie(&http.Cookie{
		Name:     sessionCookieName,
		Value:    "",
		Path:     "/", // TODO: this path is not context path safe
		Expires:  time.Unix(0, 0),
		HttpOnly: true,
	})
}

func IsAuthenticated(c echo.Context) bool {
	userId, err := GetUserIdFromSession(c)
	if err != nil && userId != 0 {
		return true
	} else {
		clearSessionCookie(c)
		return false
	}
}

func CreateSessionBasedOidcDelegate(resolveUsername func(username string) (int, error), fallbackRedirectUrl string) func(c echo.Context, idToken *oidc.IDToken, state string) error {
	return func(c echo.Context, idToken *oidc.IDToken, state string) error {
		// we now have a valid ID token, to progress in the application we need to map this
		// to an existing user or create a new one on demand
		username := idToken.Subject
		userId, err := resolveUsername(username)
		// controller.Store.FindOrCreateUser(username)
		if err != nil {
			log.Println("Error retrieving or creating user: ", err)
			return c.Render(http.StatusInternalServerError, "error-internal", nil)
		}
		// we have a valid user, we can now create a session and redirect to the original request
		sess, _ := session.Get(sessionCookieName, c)
		sess.Values["userid"] = userId
		err = sess.Save(c.Request(), c.Response())
		if err != nil {
			log.Println(err)
			return c.Render(http.StatusInternalServerError, "error-internal", nil)
		}
		stateParts := strings.Split(state, "|")
		if len(stateParts) > 1 {
			originalRequestUrlBase64 := stateParts[1]
			decodedOriginalRequestUrl, err := base64.StdEncoding.DecodeString(originalRequestUrlBase64)
			if err != nil {
				log.Println(err)
				return c.Render(http.StatusInternalServerError, "error-internal", nil)
			}
			return c.Redirect(http.StatusFound, string(decodedOriginalRequestUrl))
		} else {
			// this is just for robustness, if the state is valid, but does not contain a redirect URL
			// we just go to the bookmarks page
			return c.Redirect(http.StatusFound, fallbackRedirectUrl)
		}
	}
}
