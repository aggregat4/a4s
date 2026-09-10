package oidc

import (
	"context"
	"encoding/base64"
	"log"
	"net/http"
	"time"

	"github.com/aggregat4/a4s/pkg/crypto"
	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

// OidcConfiguration represents the OIDC middleware using standard net/http
type OidcConfiguration struct {
	IdpServerUrl string
	ClientId     string
	ClientSecret string
	RedirectUrl  string
	Skipper      func(r *http.Request) bool
	oidcProvider *oidc.Provider
	oidcConfig   oauth2.Config
}

// CreateOidcConfiguration creates a new OIDC middleware instance using standard net/http
func CreateOidcConfiguration(idpServerUrl string, clientId string, clientSecret string, redirectUrl string) *OidcConfiguration {
	ctx := context.Background()
	createdOidcProvider, err := oidc.NewProvider(ctx, idpServerUrl)
	if err != nil {
		panic(err)
	}
	return &OidcConfiguration{
		IdpServerUrl: idpServerUrl,
		ClientId:     clientId,
		ClientSecret: clientSecret,
		RedirectUrl:  redirectUrl,
		oidcProvider: createdOidcProvider,
		oidcConfig: oauth2.Config{
			ClientID:     clientId,
			ClientSecret: clientSecret,
			RedirectURL:  redirectUrl,
			Endpoint:     createdOidcProvider.Endpoint(),
			Scopes:       []string{oidc.ScopeOpenID},
		},
	}
}

// oidcStateCookieName is the cookie that carries the CSRF state for an
// in-flight authorization request.
const oidcStateCookieName = "oidc-callback-state-cookie"

// CreateOidcAuthenticationMiddleware returns a middleware function that handles OIDC authentication
func (oidcMiddleware *OidcConfiguration) CreateOidcAuthenticationMiddleware(isAuthenticated func(r *http.Request) bool, skipper func(r *http.Request) bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !skipper(r) && !isAuthenticated(r) {
				// Reuse an in-flight state cookie when one is present. A single
				// cookie cannot hold more than one state, so overwriting it on
				// every unauthenticated request would invalidate any authorization
				// attempt that is already in progress in another tab or request.
				state := ""
				if existing, err := r.Cookie(oidcStateCookieName); err == nil && existing.Value != "" {
					state = existing.Value
				} else {
					generated, err := crypto.RandomString(16)
					if err != nil {
						http.Error(w, "Unauthorized", http.StatusUnauthorized)
						return
					}
					// encode the original request URL into the state
					state = generated + "|" + base64.StdEncoding.EncodeToString([]byte(r.URL.String()))
					http.SetCookie(w, &http.Cookie{
						Name:     oidcStateCookieName,
						Value:    state,
						Path:     "/",
						Expires:  time.Now().Add(time.Minute * 5),
						HttpOnly: true,
					})
				}
				http.Redirect(w, r, oidcMiddleware.oidcConfig.AuthCodeURL(state), http.StatusFound)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// CreateOidcCallbackHandler creates a handler for the OIDC callback endpoint
func (oidcMiddleware *OidcConfiguration) CreateOidcCallbackHandler(delegate func(w http.ResponseWriter, r *http.Request, idToken *oidc.IDToken, state string) error) http.HandlerFunc {
	verifier := oidcMiddleware.oidcProvider.Verifier(&oidc.Config{ClientID: oidcMiddleware.oidcConfig.ClientID})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// check state vs cookie
		stateCookie, err := r.Cookie(oidcStateCookieName)
		if err != nil {
			log.Println(err)
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		if r.URL.Query().Get("state") != stateCookie.Value {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}

		oauth2Token, err := oidcMiddleware.oidcConfig.Exchange(r.Context(), r.URL.Query().Get("code"))
		if err != nil {
			log.Println(err)
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}

		rawIDToken, ok := oauth2Token.Extra("id_token").(string)
		if !ok {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}

		idToken, err := verifier.Verify(r.Context(), rawIDToken)
		if err != nil {
			log.Println(err)
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}

		err = delegate(w, r, idToken, stateCookie.Value)
		if err != nil {
			http.Error(w, "Internal Server Error", http.StatusInternalServerError)
			return
		}
	})
}
