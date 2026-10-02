package server

import (
	"html/template"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestRender_TemplateErrorDoesNotWritePartialPage(t *testing.T) {
	server := testServer(t, mockStoreEmpty())
	server.templates = template.Must(template.New("page.html").Parse(`partial output {{.Missing}}`))

	w := httptest.NewRecorder()
	server.render(w, "page.html", struct{}{})

	assert.Equal(t, http.StatusInternalServerError, w.Code)
	assert.NotContains(t, w.Body.String(), "partial output")
}

func TestRender_WritesHTML(t *testing.T) {
	server := testServer(t, mockStoreEmpty())
	server.templates = template.Must(template.New("page.html").Parse(`<p>{{.}}</p>`))

	w := httptest.NewRecorder()
	server.render(w, "page.html", "hello")

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Equal(t, "text/html; charset=utf-8", w.Header().Get("Content-Type"))
	assert.Equal(t, "<p>hello</p>", w.Body.String())
}
