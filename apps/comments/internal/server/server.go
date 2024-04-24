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
			// we only want authentication on admin endpoints
			return !strings.HasPrefix(c.Path(), "/admin")
		})
	e.Use(oidcMiddleware.CreateOidcMiddleware(baseliboidc.IsAuthenticated))
	e.Use(middleware.Logger())
	e.Use(middleware.Recover())
	e.Use(middleware.GzipWithConfig(middleware.GzipConfig{Level: 5}))
	// Endpoints
	e.GET("/oidccallback", oidcMiddleware.CreateOidcCallbackEndpoint(baseliboidc.CreateSessionBasedOidcDelegate(
		func(username string) (int, error) {
			//return controller.Store.FindOrCreateUser(username)
			return 0, errors.New("not implemented")
		}, "/bookmarks")))
	// We can display all comments for a post
	e.GET("/services/:serviceId/posts/:postId/comments", GetComments)
	// One can write a comment for a post
	e.GET("/services/:serviceId/posts/:postId/commentform", GetCommentForm)
	// One can add that comment to the post (in state unauthenticated)
	e.POST("/services/:serviceId/posts/:postId/comments", PostComment)
	// One can authenticate posts by clicking on an authentication link sent by email
	e.GET("/userauthentication/:token", GetUserAuthentication)
	// If users are not authenticated (we check a cookie) then we redirect them to a page where they can request an authentication link
	// This is just the "userauthentication" endpoint without a token, it has a form where you can enter your email address
	e.POST("/userauthentication", RequestAuthenticationLink)
	// The userauthentication endpoint after successfully validating the token:
	// 1. sets a cookie with the userId
	// 2. redirects to a user's comment overview and management page
	// Calling this page with a special parameter or content-type allows you to export the page as a json document
	e.GET("/users/:userId/comments", GetCommentsForUser)
	// Users can delete comments
	e.DELETE("/users/:userId/comments/:commentId", DeleteComment)
	// Users can update comments (TODO: add comment edit form here, can we reuse original form?)
	e.PUT("/users/:userId/comments/:commentId", UpdateComment)
	// Service administrators can access a service comment dashboard where they can approve or deny comments
	// They require successful OIDC authentication and they require the "service-admin" claim with the value of the service's ID
	// We need to store not only the user Id but also the user's claims here so we can always verify he or she has acces
	// to the particular service
	e.GET("/services/:serviceId/admin", GetCommentAdminOverview)
	// Since we collect private data, we need to provide a GDPR compliant privacy policy
	e.GET("/privacypolicy", PrivacyPolicy)
	return e
}

type Template struct {
	templates *template.Template
}

func (t *Template) Render(w io.Writer, name string, data interface{}, _ echo.Context) error {
	return t.templates.ExecuteTemplate(w, name, data)
}
