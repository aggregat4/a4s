// Package oidcecho contains Bookmarks' Echo-specific OIDC adapter.
package oidcecho

import (
	"context"
	"encoding/base64"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/aggregat4/a4s/pkg/crypto"
	coreosoidc "github.com/coreos/go-oidc/v3/oidc"
	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
	"golang.org/x/oauth2"
)

// OidcMiddleware preserves Bookmarks' Echo-oriented OIDC behavior while the
// shared OIDC package remains standard net/http only.
type OidcMiddleware struct {
	IdpServerUrl string
	ClientId     string
	ClientSecret string
	RedirectUrl  string
	Skipper      middleware.Skipper
	oidcProvider *coreosoidc.Provider
	oidcConfig   oauth2.Config
}

// NewOidcMiddleware creates an Echo OIDC middleware configuration.
func NewOidcMiddleware(idpServerUrl, clientId, clientSecret, redirectUrl string, skipper middleware.Skipper) *OidcMiddleware {
	createdOIDCProvider, err := coreosoidc.NewProvider(context.Background(), idpServerUrl)
	if err != nil {
		panic(err)
	}
	return &OidcMiddleware{
		IdpServerUrl: idpServerUrl,
		ClientId:     clientId,
		ClientSecret: clientSecret,
		RedirectUrl:  redirectUrl,
		oidcProvider: createdOIDCProvider,
		Skipper:      skipper,
		oidcConfig: oauth2.Config{
			ClientID:     clientId,
			ClientSecret: clientSecret,
			RedirectURL:  redirectUrl,
			Endpoint:     createdOIDCProvider.Endpoint(),
			Scopes:       []string{coreosoidc.ScopeOpenID},
		},
	}
}

// CreateOidcMiddleware returns Echo middleware that redirects unauthenticated
// requests to the configured OIDC provider.
func (oidcMiddleware *OidcMiddleware) CreateOidcMiddleware(isAuthenticated func(c echo.Context) bool) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			if !oidcMiddleware.Skipper(c) && !isAuthenticated(c) {
				state, err := crypto.RandomString(16)
				if err != nil {
					return c.Render(http.StatusUnauthorized, "error-unauthorized", nil)
				}
				state += "|" + base64.StdEncoding.EncodeToString([]byte(c.Request().URL.String()))
				c.SetCookie(&http.Cookie{
					Name:     "oidc-callback-state-cookie",
					Value:    state,
					Path:     "/",
					Expires:  time.Now().Add(5 * time.Minute),
					HttpOnly: true,
				})
				return c.Redirect(http.StatusFound, oidcMiddleware.oidcConfig.AuthCodeURL(state))
			}
			return next(c)
		}
	}
}

// CreateOidcCallbackEndpoint returns the Echo OIDC callback handler.
func (oidcMiddleware *OidcMiddleware) CreateOidcCallbackEndpoint(delegate func(c echo.Context, idToken *coreosoidc.IDToken, state string) error) echo.HandlerFunc {
	verifier := oidcMiddleware.oidcProvider.Verifier(&coreosoidc.Config{ClientID: oidcMiddleware.oidcConfig.ClientID})
	return func(c echo.Context) error {
		state, err := c.Cookie("oidc-callback-state-cookie")
		if err != nil {
			log.Println(err)
			return c.Render(http.StatusUnauthorized, "error-unauthorized", nil)
		}
		if c.QueryParam("state") != state.Value {
			return c.Render(http.StatusUnauthorized, "error-unauthorized", nil)
		}
		oauth2Token, err := oidcMiddleware.oidcConfig.Exchange(c.Request().Context(), c.QueryParam("code"))
		if err != nil {
			log.Println(err)
			return c.Render(http.StatusUnauthorized, "error-unauthorized", nil)
		}
		rawIDToken, ok := oauth2Token.Extra("id_token").(string)
		if !ok {
			return c.Render(http.StatusUnauthorized, "error-unauthorized", nil)
		}
		idToken, err := verifier.Verify(c.Request().Context(), rawIDToken)
		if err != nil {
			log.Println(err)
			return c.Render(http.StatusUnauthorized, "error-unauthorized", nil)
		}
		return delegate(c, idToken, state.Value)
	}
}

// CreateSessionBasedOidcDelegate preserves Bookmarks' state redirect behavior.
func CreateSessionBasedOidcDelegate(handleIDToken func(c echo.Context, idToken *coreosoidc.IDToken) error, fallbackRedirectURL string) func(c echo.Context, idToken *coreosoidc.IDToken, state string) error {
	return func(c echo.Context, idToken *coreosoidc.IDToken, state string) error {
		if err := handleIDToken(c, idToken); err != nil {
			return c.Render(http.StatusInternalServerError, "error-internal", nil)
		}
		stateParts := strings.Split(state, "|")
		if len(stateParts) <= 1 {
			return c.Redirect(http.StatusFound, fallbackRedirectURL)
		}
		originalRequestURL, err := base64.StdEncoding.DecodeString(stateParts[1])
		if err != nil {
			log.Println(err)
			return c.Render(http.StatusInternalServerError, "error-internal", nil)
		}
		return c.Redirect(http.StatusFound, string(originalRequestURL))
	}
}
