package server

import (
	"io"
	"net/http"
	"net/http/cookiejar"
	"testing"
	"time"
)

func createMockOidcCallback() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}
}

func createMockOidcMiddleware() func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			next.ServeHTTP(w, r)
		})
	}
}

func waitForServerStart(t *testing.T, url string) {
	const maxRetries = 10
	for i := 0; i < maxRetries; i++ {
		resp, err := http.Get(url)
		if err == nil && resp != nil && resp.StatusCode == http.StatusOK {
			_ = resp.Body.Close()
			return
		}
		time.Sleep(500 * time.Millisecond)
	}
	t.Fatalf("Server did not start after %d retries", maxRetries)
}

func readBody(res *http.Response) string {
	body, err := io.ReadAll(res.Body)
	if err != nil {
		panic(err)
	}
	defer res.Body.Close()
	return string(body)
}

func createTestHttpClient(followRedirects bool) *http.Client {
	jar, _ := cookiejar.New(nil)
	if !followRedirects {
		return &http.Client{
			Jar: jar,
			// we need to prevent the client from redirecting automatically since we may need to assert
			// against the location header
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				return http.ErrUseLastResponse
			},
			//Transport: &http.Transport{DisableKeepAlives: true},
		}
	} else {
		return &http.Client{
			Jar: jar,
		}
	}
}
