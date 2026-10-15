package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDevUserMiddlewareUsesTheRequestedUser(t *testing.T) {
	var got string
	handler := DevUserMiddleware("")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got, _ = UserIDFromContext(r.Context())
	}))

	for _, tc := range []struct{ cookie, want string }{
		{"", "dev-user"},
		{"e2e-1", "e2e-1"},
	} {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		if tc.cookie != "" {
			req.AddCookie(&http.Cookie{Name: DevUserCookie, Value: tc.cookie})
		}
		handler.ServeHTTP(httptest.NewRecorder(), req)
		if got != tc.want {
			t.Errorf("cookie %q: user %q, want %q", tc.cookie, got, tc.want)
		}
	}
}
