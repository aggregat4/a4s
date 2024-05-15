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
	"net/http"
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

type Template struct {
	templates *template.Template
}

func (t *Template) Render(w io.Writer, name string, data interface{}, _ echo.Context) error {
	return t.templates.ExecuteTemplate(w, name, data)
}

func InitServer(controller Controller) *echo.Echo {
	oidcMiddleware := baseliboidc.NewOidcMiddleware(
		controller.Config.OidcIdpServer,
		controller.Config.OidcClientId,
		controller.Config.OidcClientSecret,
		controller.Config.OidcRedirectUri,
		func(c echo.Context) bool {
			// we only want authentication on admin endpoints
			return !strings.HasPrefix(c.Path(), "/admin")
		})
	oidcCallback := oidcMiddleware.CreateOidcCallbackEndpoint(baseliboidc.CreateSessionBasedOidcDelegate(
		func(username string) (int, error) {
			//return controller.Store.FindOrCreateUser(username)
			return 0, errors.New("not implemented")
		}, "/admin"))
	return InitServerWithOidcMiddleware(controller, oidcMiddleware.CreateOidcMiddleware(baseliboidc.IsAuthenticated), oidcCallback)
}

func InitServerWithOidcMiddleware(
	controller Controller,
	oidcMiddleware echo.MiddlewareFunc,
	oidcCallback func(c echo.Context) error,
) *echo.Echo {
	e := echo.New()

	// Set server timeouts based on advice from https://blog.cloudflare.com/the-complete-guide-to-golang-net-http-timeouts/#1687428081
	e.Server.ReadTimeout = time.Duration(controller.Config.ServerReadTimeoutSeconds) * time.Second
	e.Server.WriteTimeout = time.Duration(controller.Config.ServerWriteTimeoutSeconds) * time.Second

	e.Renderer = &Template{
		templates: template.Must(template.New("").ParseFS(viewTemplates, "public/views/*.html")),
	}

	// Set up middleware
	e.Use(oidcMiddleware)
	e.Use(middleware.Logger())
	e.Use(middleware.Recover())
	e.Use(middleware.GzipWithConfig(middleware.GzipConfig{Level: 5}))

	// Endpoints
	e.GET("/oidccallback", oidcCallback)
	// ---- UNAUTHENTICATED
	// Status endpoint
	e.GET("/status", controller.Status)
	// Since we collect private data, we need to provide a GDPR compliant privacy policy
	// This should be configurable as the contents depend on the admin. Can we just serve a file?
	//	e.GET("/privacypolicy", controller.PrivacyPolicy)
	// We can display all comments for a post
	e.GET("/services/:serviceKey/posts/:postKey/comments", controller.GetComments)
	// One can write a comment for a post, the comment form is prefilled if you are authenticated
	//	e.GET("/services/:serviceKey/posts/:postKey/commentform", controller.GetCommentForm)
	// One can add that comment to the post (in state unauthenticated, assuming we have all the info we need (at least email and content))
	//	e.POST("/services/:serviceKey/posts/:postKey/comments", controller.PostComment)

	// ----- User Authentication
	// One can authenticate posts by clicking on an authentication link sent by email, this has to be GET because we send this via email
	//	e.GET("/userauthentication/:token", controller.AuthenticateUser)
	// If users are not authenticated (we check a cookie) then we redirect them to a page where they can request an authentication link
	// This is just the "userauthentication" endpoint without a token, it has a form where you can enter your email address
	//  e.GET("/userauthentication/", controller.GetAuthenticateUserForm)
	// Users can submit a userauthentication form to get a new token sent
	//	e.POST("/userauthentication", controller.RequestAuthenticationLink)
	// The userauthentication endpoint after successfully validating the token:
	// 1. sets a cookie with the userId
	// 2. redirects to a user's comment overview and management page

	// ---- AUTHENTICATED WITH AUTH TOKEN via email (i.e. userid in cookie)
	// Calling this page with a special parameter or content-type allows you to export the page as a json document
	//	e.GET("/users/:userId/comments", controller.GetCommentsForUser)
	// Allow a user to modify his comment
	//	e.GET("/users/:userId/comments/:commentId", controller.GetCommentEditForm)
	// Users can delete comments, this redirects back to the comment overview page
	//	e.DELETE("/users/:userId/comments/:commentId", controller.DeleteComment)
	// Users can update comments (TODO: add comment edit form here, can we reuse original form?)
	//	e.PUT("/users/:userId/comments/:commentId", controller.UpdateComment)

	// ---- AUTHENTICATED WITH OIDC AND ROLE service-admin
	// Service administrators can access a service comment dashboard where they can approve or deny comments
	// They require successful OIDC authentication and they require the "service-admin" value as part of the values
	// in the "roles" claim
	// We need to store not only the user Id but also the admin's claims in his cookie here so we can always verify he or she has acces
	// to the particular service
	// Don't show unauthenticated comments by default
	//	e.GET("/admin", controller.GetCommentAdminOverview)

	return e
}

// GetComments Renders a page with all the comments for the given post with a CSP policy that restricts embedding in
// the configured origin for that service.
func (controller *Controller) GetComments(c echo.Context) error {
	serviceKey := c.Param("serviceKey")
	postKey := c.Param("postKey")
	logger.Info("GetComments called for serviceKey " + serviceKey + " and postKey " + postKey)
	if serviceKey == "" || postKey == "" {
		return c.Render(http.StatusBadRequest, "error-badrequest", nil)
	}
	service, err := controller.Store.GetServiceForKey(serviceKey)
	if err != nil {
		return sendInternalError(c, err)
	}
	if service == nil {
		return c.Render(http.StatusNotFound, "error-notfound", nil)
	}
	comments, err := controller.Store.GetComments(service.Id, postKey)
	if err != nil {
		return sendInternalError(c, err)
	}
	c.Response().Header().Set("Content-Security-Policy", "frame-ancestors "+service.Origin)
	return c.Render(http.StatusOK, "postcomments", domain.PostCommentsPage{
		ServiceKey: serviceKey,
		PostKey:    postKey,
		Comments:   comments,
	})
}

func sendInternalError(c echo.Context, err error) error {
	logger.Error("Error processing request: ", err)
	return c.Render(http.StatusInternalServerError, "error-internalserver", nil)
}

func (controller *Controller) Status(c echo.Context) error {
	logger.Info("Status endpoint")
	return c.Render(http.StatusOK, "status", "OK")
}
