package server

import (
	"aggregat4/go-commentservice/internal/domain"
	"aggregat4/go-commentservice/internal/repository"
	"github.com/labstack/echo/v4"
	_ "github.com/mattn/go-sqlite3"
	"github.com/stretchr/testify/assert"
	"io"
	"net/http"
	"strconv"
	"testing"
	"time"
)

var serverConfig = domain.Config{
	Port:                      8080,
	DatabaseFilename:          "",
	ServerReadTimeoutSeconds:  50,
	ServerWriteTimeoutSeconds: 100,
	OidcIdpServer:             "",
	OidcClientId:              "",
	OidcClientSecret:          "",
	OidcRedirectUri:           "",
	EncryptionKey:             "testencryptionkey",
}

func TestEmptyCommentsPage(t *testing.T) {
	echoServer, controller := waitForServer(t)
	defer echoServer.Close()
	defer controller.Store.Close()
	res, err := http.Get(createServerUrl(serverConfig.Port, "/services/foo/posts/bar/comments"))
	if err != nil {
		t.Fatal(err)
	}
	assert.Equal(t, 200, res.StatusCode)
	assert.Equal(t, "text/html; charset=UTF-8", res.Header.Get("Content-Type"))
	//assert.Equal(t, "no-store", res.Header.Get("Cache-Control"))
	//assert.Contains(t, readBody(res), fmt.Sprintf("value=\"%s\"", TestState))
	body := readBody(res)
	assert.Contains(t, body, "<h1>Comments</h1>")
	assert.Contains(t, body, "<dl class=\"comments\">")
	assert.NotContains(t, body, "<dt>")
	assert.NotContains(t, body, "<dd>")
}

func waitForServer(t *testing.T) (*echo.Echo, Controller) {
	var store repository.Store
	err := store.InitAndVerifyDb(repository.CreateInMemoryDbUrl())
	if err != nil {
		panic(err)
	}
	controller := Controller{&store, serverConfig}
	echoServer := InitServer(controller)
	go func() {
		_ = echoServer.Start(":" + strconv.Itoa(serverConfig.Port))
	}()
	waitForServerStart(t, createServerUrl(serverConfig.Port, "/status"))
	return echoServer, controller
}

func waitForServerStart(t *testing.T, url string) {
	maxRetries := 10
	for i := 0; i < maxRetries; i++ {
		resp, err := http.Get(url)
		if err == nil {
			resp.Body.Close()
			return
		}
		time.Sleep(time.Second)
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

func createServerUrl(port int, path string) string {
	return "http://localhost:" + strconv.Itoa(port) + path
}
