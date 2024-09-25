package server

import (
	"io"
	"net/http"
	"net/http/cookiejar"
	"testing"
	"time"

	"github.com/labstack/echo/v4"
)

func createMockOidcCallback() echo.HandlerFunc {
	return func(c echo.Context) error {
		return nil
	}
}

func createMockOidcMiddleware() echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			return next(c)
		}
	}
}

func waitForServerStart(t *testing.T, url string) {
	maxRetries := 10
	for i := 0; i < maxRetries; i++ {
		resp, err := http.Get(url)
		if err == nil && (resp != nil && resp.StatusCode == 200) {
			resp.Body.Close()
			return
		}
		time.Sleep(time.Millisecond * 500)
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
