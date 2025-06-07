package oidc

import (
	"encoding/base64"
	"log"
	"net/http"
	"strings"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/gorilla/sessions"
)

var STDSessionCookieName = "baselib-oidc-session-cookie"

// SessionStore is a wrapper around gorilla/sessions.Store
type SessionStoreStd struct {
	store *sessions.CookieStore
}

// NewSessionStore creates a new session store with the given secret key
func NewSessionStoreStd(secretKey []byte) *SessionStoreStd {
	return &SessionStoreStd{
		store: sessions.NewCookieStore(secretKey),
	}
}

// SetFlash sets a flash message with a given key (e.g., "success", "error")
func (s *SessionStoreStd) SetFlash(w http.ResponseWriter, r *http.Request, key, message string) error {
	session, err := s.store.Get(r, STDSessionCookieName)
	if err != nil {
		return err
	}

	session.AddFlash(message, key)
	return session.Save(r, w)
}

// GetFlashes retrieves and clears flash messages for the given keys
func (s *SessionStoreStd) GetFlashes(w http.ResponseWriter, r *http.Request) ([]string, []string, error) {
	session, err := s.store.Get(r, STDSessionCookieName)
	if err != nil {
		return nil, nil, err
	}

	var successFlashes = getSessionFlashesStd(session, "success")
	var errorFlashes = getSessionFlashesStd(session, "error")

	session.Save(r, w)
	return successFlashes, errorFlashes, nil
}

func getSessionFlashesStd(session *sessions.Session, key string) []string {
	flashes := session.Flashes(key)
	var flashesList []string
	for _, flash := range flashes {
		if msg, ok := flash.(string); ok {
			flashesList = append(flashesList, msg)
		}
	}
	return flashesList
}

// HandleIdTokenFunc is a function type that handles the ID token after successful authentication
type HandleIdTokenFuncStd func(w http.ResponseWriter, r *http.Request, idToken *oidc.IDToken) error

// CreateSTDSessionBasedOidcDelegate creates a delegate function that handles the OIDC callback
// and redirects to the original request URL or fallback URL
func CreateSTDSessionBasedOidcDelegate(handleIdToken HandleIdTokenFuncStd, fallbackRedirectUrl string) func(w http.ResponseWriter, r *http.Request, idToken *oidc.IDToken, state string) error {
	return func(w http.ResponseWriter, r *http.Request, idToken *oidc.IDToken, state string) error {
		err := handleIdToken(w, r, idToken)
		if err != nil {
			http.Error(w, "Internal Server Error", http.StatusInternalServerError)
			return err
		}

		stateParts := strings.Split(state, "|")
		if len(stateParts) > 1 {
			originalRequestUrlBase64 := stateParts[1]
			decodedOriginalRequestUrl, err := base64.StdEncoding.DecodeString(originalRequestUrlBase64)
			if err != nil {
				log.Println(err)
				http.Error(w, "Internal Server Error", http.StatusInternalServerError)
				return err
			}
			http.Redirect(w, r, string(decodedOriginalRequestUrl), http.StatusFound)
			return nil
		} else {
			// this is just for robustness, if the state is valid, but does not contain a redirect URL
			// we just go to the fallback URL
			http.Redirect(w, r, fallbackRedirectUrl, http.StatusFound)
			return nil
		}
	}
}
