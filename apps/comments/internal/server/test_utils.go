package server

import (
	"bytes"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
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

type handlerRoundTripper struct {
	handler http.Handler
}

func (rt handlerRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	var bodyCopy []byte
	if req.Body != nil {
		var err error
		bodyCopy, err = io.ReadAll(req.Body)
		if err != nil {
			return nil, err
		}
		_ = req.Body.Close()
	}

	reqClone := req.Clone(req.Context())
	if bodyCopy != nil {
		reqClone.Body = io.NopCloser(bytes.NewReader(bodyCopy))
		reqClone.ContentLength = int64(len(bodyCopy))
	} else {
		reqClone.Body = nil
		reqClone.ContentLength = 0
	}
	reqClone.RequestURI = req.URL.RequestURI()
	reqClone.Host = req.URL.Host

	recorder := httptest.NewRecorder()
	rt.handler.ServeHTTP(recorder, reqClone)
	resp := recorder.Result()
	resp.Request = req

	if bodyCopy != nil {
		req.Body = io.NopCloser(bytes.NewReader(bodyCopy))
	}

	return resp, nil
}

func readBody(res *http.Response) string {
	body, err := io.ReadAll(res.Body)
	if err != nil {
		panic(err)
	}
	defer res.Body.Close()
	return string(body)
}

func createTestHttpClient(handler http.Handler, followRedirects bool) *http.Client {
	jar, _ := cookiejar.New(nil)
	client := &http.Client{
		Jar:       jar,
		Transport: handlerRoundTripper{handler: handler},
	}
	if !followRedirects {
		client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		}
	}
	return client
}
