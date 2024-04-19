package server

import (
	"aggregat4/go-commentservice/internal/domain"
	"aggregat4/go-commentservice/internal/repository"
	"embed"
	"errors"
	baseliboidc "github.com/aggregat4/go-baselib-services/oidc"
	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
	"html/template"
	"io"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"time"
)

var logger = slog.New(slog.NewTextHandler(os.Stdout, nil))

//go:embed public/views/*.html
var viewTemplates embed.FS

const ContentTypeJson = "application/json;charset=UTF-8"

type Controller struct {
	Store  *repository.Store
	Config domain.Config
}

func RunServer(controller Controller) {
	e := InitServer(controller)
	e.Logger.Fatal(e.Start(":" + strconv.Itoa(controller.Config.Port)))
	// NO MORE CODE HERE, IT WILL NOT BE EXECUTED
}

func InitServer(controller Controller) *echo.Echo {
	e := echo.New()
	// Set server timeouts based on advice from https://blog.cloudflare.com/the-complete-guide-to-golang-net-http-timeouts/#1687428081
	e.Server.ReadTimeout = time.Duration(controller.Config.ServerReadTimeoutSeconds) * time.Second
	e.Server.WriteTimeout = time.Duration(controller.Config.ServerWriteTimeoutSeconds) * time.Second

	e.Renderer = &Template{
		templates: template.Must(template.New("").ParseFS(viewTemplates, "public/views/*.html")),
	}
	// Set up middleware
	oidcMiddleware := baseliboidc.NewOidcMiddleware(
		controller.Config.OidcIdpServer,
		controller.Config.OidcClientId,
		controller.Config.OidcClientSecret,
		controller.Config.OidcRedirectUri,
		func(c echo.Context) bool {
			return !strings.HasPrefix(c.Path(), "/admin")
		})
	e.Use(oidcMiddleware.CreateOidcMiddleware(baseliboidc.IsAuthenticated))
	e.Use(middleware.Logger())
	e.Use(middleware.Recover())
	// Debug logging
	//e.Use(middleware.BodyDump(func(c echo.Context, reqBody, resBody []byte) {
	//	logger.Info("Request: %s %s", "requestmethod", c.Request().Method, "requesturl", c.Request().URL)
	//	logger.Info("Response: %s", "responsebody", string(resBody))
	//}))
	//e.Use(session.Middleware(sessions.NewCookieStore([]byte(uuid.New().String()))))
	e.Use(middleware.GzipWithConfig(middleware.GzipConfig{Level: 5}))
	// Endpoints
	e.GET("/oidccallback", oidcMiddleware.CreateOidcCallbackEndpoint(baseliboidc.CreateSessionBasedOidcDelegate(
		func(username string) (int, error) {
			//return controller.Store.FindOrCreateUser(username)
			return 0, errors.New("not implemented")
		}, "/bookmarks")))
	return e
}

type Template struct {
	templates *template.Template
}

func (t *Template) Render(w io.Writer, name string, data interface{}, _ echo.Context) error {
	return t.templates.ExecuteTemplate(w, name, data)
}
