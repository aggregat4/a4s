package server

import (
	"aggregat4/go-commentservice/internal/domain"
	"aggregat4/go-commentservice/internal/email"
	"aggregat4/go-commentservice/internal/repository"
	"embed"
	"errors"
	baseliboidc "github.com/aggregat4/go-baselib-services/v2/oidc"
	"github.com/aggregat4/go-baselib/lang"
	"github.com/google/uuid"
	"github.com/gorilla/sessions"
	"github.com/labstack/echo-contrib/session"
	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
	"html/template"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

var logger = slog.New(slog.NewTextHandler(os.Stdout, nil))

//go:embed public/views/*.html
var viewTemplates embed.FS

//go:embed public/js/*.js
var javaScript embed.FS

const ContentTypeJson = "application/json;charset=UTF-8"

type Controller struct {
	Store       *repository.Store
	Config      domain.Config
	EmailSender *email.EmailSender
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
	return InitServerWithOidcMiddleware(
		controller,
		oidcMiddleware.CreateOidcMiddleware(baseliboidc.IsAuthenticated),
		oidcCallback)
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
	e.Use(middleware.Logger())
	e.Use(middleware.Recover())
	sessionCookieSecretKey := controller.Config.SessionCookieSecretKey
	e.Use(session.Middleware(sessions.NewCookieStore([]byte(sessionCookieSecretKey))))
	e.Use(middleware.GzipWithConfig(middleware.GzipConfig{Level: 5}))
	// user authentication is required for pages related to a user's comments
	e.Use(oidcMiddleware)
	e.Use(CreateUserAuthenticationMiddleware(func(c echo.Context) bool {
		return !strings.HasPrefix(c.Path(), "/users/")
	}))
	// TODO: CSRF origin check (on non HEAD or GET requests, check that Origin header matches target origin)

	// Endpoints
	javaScriptFS := echo.MustSubFS(javaScript, "public/js")
	e.StaticFS("/js", javaScriptFS)
	e.GET("/oidccallback", oidcCallback)
	// ---- UNAUTHENTICATED
	// Status endpoint
	e.GET("/status", controller.Status)
	// Since we collect private data, we need to provide a GDPR compliant privacy policy
	// This should be configurable as the contents depend on the admin. Can we just serve a file?
	// TODO: e.GET("/privacypolicy", controller.PrivacyPolicy)
	// We can display all comments for a post
	e.GET("/services/:serviceKey/posts/:postKey/comments", controller.GetComments)
	// One can write a comment for a post, the comment form is prefilled if you are authenticated
	e.GET("/services/:serviceKey/posts/:postKey/commentform", controller.GetCommentForm)
	// One can add that comment to the post (in state unauthenticated, assuming we have all the info we need (at least email and content))
	e.POST("/services/:serviceKey/posts/:postKey/comments", controller.PostComment)

	// ----- User Authentication
	// If users are not authenticated (we check a cookie) then we redirect them to a page where they can request an authentication link
	// This is just the "userauthentication" endpoint without a token, it has a form where you can enter your email address
	e.GET("/userauthentication/", controller.GetUserAuthenticationForm)
	// Users can submit a userauthentication form to get a new token sent
	e.POST("/userauthentication", controller.RequestAuthenticationLink)
	// Users can authenticate by clicking on an authentication link sent by email, this has to be GET because email
	e.GET("/userauthentication/:token", controller.AuthenticateUser)
	// After authenticating the user:
	// 1. sets a cookie with the userId
	// 2. redirects to a user's comment overview and management page

	// ---- AUTHENTICATED WITH AUTH TOKEN (normal user)
	// Calling this page with a special parameter or content-type allows you to export the page as a json document
	e.GET("/users/:userId/comments", controller.GetCommentsForUser)
	// Allow a user to modify his comment
	e.GET("/users/:userId/comments/:commentId", controller.GetUserCommentForm)
	// Users can delete comments, this redirects back to the comment overview page
	e.POST("/users/:userId/comments/:commentId/delete", controller.DeleteUserComment)
	// Users can update comments

	// ---- AUTHENTICATED WITH OIDC AND ROLE service-admin (admimistrator)
	// Service administrators can access a service comment dashboard where they can approve or deny comments
	// They require successful OIDC authentication and they require the "service-admin" value as part of the values
	// in the "roles" claim
	// We need to store not only the user Id but also the admin's claims in his cookie here so we can always verify he or she has acces
	// to the particular service
	// Don't show unauthenticated comments by default
	// TODO: e.GET("/admin", controller.GetCommentAdminOverview)

	return e
}

// GetComments Renders a page with all the comments for the given post with a CSP policy that restricts embedding to
// the configured origin for that service.
func (controller *Controller) GetComments(c echo.Context) error {
	serviceKey := c.Param("serviceKey")
	postKey := c.Param("postKey")
	if serviceKey == "" || postKey == "" {
		return c.Render(http.StatusBadRequest, "error-badrequest", nil)
	}
	service, err := controller.Store.GetServiceForKey(serviceKey)
	if err != nil {
		if errors.Is(err, lang.ErrNotFound) {
			return c.Render(http.StatusNotFound, "error-notfound", nil)
		}
		return sendInternalError(c, err)
	}
	comments, err := controller.Store.GetCommentsForPost(service.Id, postKey)
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

func (controller *Controller) Status(c echo.Context) error {
	logger.Info("Status endpoint")
	return c.String(http.StatusOK, "OK")
}

type UserAuthenticationForm struct {
	EmailAddress string
	Success      string
	Error        string
}

func (controller *Controller) GetUserAuthenticationForm(c echo.Context) error {
	return c.Render(http.StatusOK, "userauthentication", UserAuthenticationForm{
		EmailAddress: c.QueryParam("emailAddress"),
		Error:        c.QueryParam("error"),
		Success:      c.QueryParam("success"),
	})
}

var fifteenMinutes = time.Duration(15) * time.Minute

func validToken(user domain.User) bool {
	return user.AuthToken != "" && time.Since(user.AuthTokenCreatedAt) <= fifteenMinutes
}

func (controller *Controller) RequestAuthenticationLink(c echo.Context) error {
	emailAddress := c.FormValue("email")
	if emailAddress == "" {
		return c.Render(http.StatusBadRequest, "error-badrequest", nil)
	}
	user, err := controller.Store.FindUserByEmail(emailAddress)
	if err != nil {
		if errors.Is(err, lang.ErrNotFound) {
			params := url.Values{}
			params.Set("emailAddress", emailAddress)
			params.Set("error", "No data was found for the user with email address '"+emailAddress+"'")
			return c.Redirect(http.StatusFound, "/userauthentication/?"+params.Encode())
		}
		return sendInternalError(c, err)
	}
	if !validToken(user) {
		user.AuthTokenSentToClient = 0
		user.AuthToken = uuid.New().String()
		user.AuthTokenCreatedAt = time.Now()
	}
	if user.AuthTokenSentToClient < 3 {
		// update the sent count to make sure future requests can delay even further
		user.AuthTokenSentToClient++
		user.AuthTokenCreatedAt = time.Now()
		err = controller.Store.UpdateUser(user)
		if err != nil {
			return sendInternalError(c, err)
		}
		var delay = 0 * time.Minute
		if user.AuthTokenSentToClient == 1 {
			delay = 1 * time.Minute
		} else if user.AuthTokenSentToClient == 2 {
			delay = 5 * time.Minute
		}
		params := url.Values{}
		params.Set("email", emailAddress)
		emailSuccessfullyQueued := controller.EmailSender.SendEmail(email.AuthenticationCodeEmail{
			EmailAddress: emailAddress,
			Code:         user.AuthToken,
		})
		if emailSuccessfullyQueued {
			if delay > 0 {
				params.Set("success", "An authentication token will be sent in "+delay.String()+".")
			} else {
				params.Set("success", "An authentication token is on the way, please check your email address.")
			}
		} else {
			// TODO error message too vague?
			params.Set("error", "Could not send an email at this time, please try again later.")
		}
		return c.Redirect(http.StatusFound, "/userauthentication/?"+params.Encode())
	} else {
		// let the user know they have to try again in 15 minutes
		params := url.Values{}
		params.Set("emailAddress", emailAddress)
		params.Set("error", "Too many attempts were made to request authentication tokens for this user. Please try again in 15 minutes.")
		return c.Redirect(http.StatusFound, "/userauthentication/?"+params.Encode())
	}
}

func (controller *Controller) AuthenticateUser(c echo.Context) error {
	token := c.Param("token")
	if token == "" {
		return c.Redirect(http.StatusFound, "/userauthentication/")
	}
	user, err := controller.Store.FindUserByAuthToken(token)
	if err != nil || !validToken(user) {
		params := url.Values{}
		params.Set("error", "Invalid token")
		return c.Redirect(http.StatusFound, "/userauthentication/?"+params.Encode())
	}
	err = createSessionCookie(c, user.Id)
	if err != nil {
		return sendInternalError(c, err)
	}
	return c.Redirect(http.StatusFound, "/users/"+strconv.Itoa(user.Id)+"/comments")
}

func handleAuthenticationError(c echo.Context, err error) error {
	if errors.Is(err, lang.ErrNotFound) {
		return c.Redirect(http.StatusFound, "/userauthentication/")
	} else {
		return sendInternalError(c, err)
	}
}

func (controller *Controller) GetCommentsForUser(c echo.Context) error {
	user, err := getUserFromSession(c, controller)
	if err != nil {
		return handleAuthenticationError(c, err)
	}
	comments, err := controller.Store.GetCommentsForUser(user.Id)
	if err != nil {
		return sendInternalError(c, err)
	}
	return c.Render(http.StatusOK, "usercomments", domain.UserCommentsPage{
		User:     user,
		Comments: comments,
	})
}

func (controller *Controller) GetCommentForm(c echo.Context) error {
	serviceKey := c.Param("serviceKey")
	postKey := c.Param("postKey")
	if serviceKey == "" || postKey == "" {
		return c.Render(http.StatusBadRequest, "error-badrequest", nil)
	}
	user, userFoundError := getUserFromSession(c, controller)
	if userFoundError != nil && !errors.Is(userFoundError, lang.ErrNotFound) {
		return sendInternalError(c, userFoundError)
	}
	commentIdString := c.QueryParam("commentId")
	commentFound := false
	comment := domain.Comment{}
	if commentIdString != "" {
		commentId, err := strconv.Atoi(commentIdString)
		if err == nil {
			comment, err = controller.Store.GetComment(commentId)
			if err != nil && !errors.Is(err, lang.ErrNotFound) {
				return sendInternalError(c, err)
			} else if err == nil {
				commentFound = true
			} else {
				return c.Render(http.StatusNotFound, "error-notfound", nil)
			}
		} else {
			return c.Render(http.StatusNotFound, "error-notfound", nil)
		}
	}
	service, err := controller.Store.GetServiceForKey(serviceKey)
	if err != nil {
		// TODO: better error to indicate that this service does not exist?
		return c.Render(http.StatusNotFound, "error-notfound", nil)
	}
	c.Response().Header().Set("Content-Security-Policy", "frame-ancestors "+service.Origin)
	return c.Render(http.StatusOK, "addeditcomment", domain.AddOrEditCommentPage{
		ServiceKey:   serviceKey,
		PostKey:      postKey,
		UserFound:    userFoundError == nil,
		User:         user,
		CommentFound: commentFound,
		Comment:      comment,
	})
}

func (controller *Controller) GetUserCommentForm(c echo.Context) error {
	user, comment, err := controller.extractAndValidateUserAndCommentFromRequest(c)
	if err != nil {
		return err
	}
	service, err := controller.Store.FindServiceById(comment.ServiceId)
	if err != nil {
		if errors.Is(err, lang.ErrNotFound) {
			return c.Render(http.StatusNotFound, "error-notfound", nil)
		} else {
			return sendInternalError(c, err)
		}
	}
	// NO CSP header to prevent embedding because this URL presupposes a logged in user and it can be called from
	// some general dashboard where a user can manage their comments
	return c.Render(http.StatusOK, "addeditcomment", domain.AddOrEditCommentPage{
		ServiceKey:   service.ServiceKey,
		PostKey:      comment.PostKey,
		UserFound:    true,
		User:         user,
		CommentFound: true,
		Comment:      comment,
	})
}

func (controller *Controller) DeleteUserComment(c echo.Context) error {
	user, comment, err := controller.extractAndValidateUserAndCommentFromRequest(c)
	if err != nil {
		return err
	}
	err = controller.Store.DeleteComment(comment.Id)
	if err != nil {
		return sendInternalError(c, err)
	}
	// TODO: toast to show that the comment has been deleted
	return c.Redirect(http.StatusFound, "/users/"+strconv.Itoa(user.Id)+"/comments")
}

func (controller *Controller) extractAndValidateUserAndCommentFromRequest(c echo.Context) (domain.User, domain.Comment, error) {
	// get and validate url parameters
	userIdString := c.Param("userId")
	commentIdString := c.Param("commentId")
	if userIdString == "" || commentIdString == "" {
		return domain.User{}, domain.Comment{}, c.Render(http.StatusBadRequest, "error-badrequest", nil)
	}
	commentId, err := strconv.Atoi(commentIdString)
	if err != nil {
		return domain.User{}, domain.Comment{}, c.Render(http.StatusBadRequest, "error-badrequest", nil)
	}
	userId, err := strconv.Atoi(userIdString)
	if err != nil {
		return domain.User{}, domain.Comment{}, c.Render(http.StatusBadRequest, "error-badrequest", nil)
	}
	// validate user
	user, err := getUserFromSession(c, controller)
	if err != nil {
		return domain.User{}, domain.Comment{}, sendInternalError(c, err)
	}
	if user.Id != userId {
		return domain.User{}, domain.Comment{}, c.Render(http.StatusUnauthorized, "error-unauthorized", nil)
	}
	// retrieve comment
	comment, err := controller.Store.GetComment(commentId)
	if err != nil {
		if errors.Is(err, lang.ErrNotFound) {
			return domain.User{}, domain.Comment{}, c.Render(http.StatusNotFound, "error-notfound", nil)
		} else {
			return domain.User{}, domain.Comment{}, sendInternalError(c, err)
		}
	}
	return user, comment, nil
}

func (controller *Controller) PostComment(c echo.Context) error {
	serviceKey := c.Param("serviceKey")
	postKey := c.Param("postKey")
	if serviceKey == "" || postKey == "" {
		return c.Render(http.StatusBadRequest, "error-badrequest", nil)
	}
	user, userFoundError := getUserFromSession(c, controller)
	if userFoundError != nil && !errors.Is(userFoundError, lang.ErrNotFound) {
		return sendInternalError(c, userFoundError)
	}
	commentIdString := c.FormValue("commentId")
	emailAddress := c.FormValue("emailAddress")
	name := c.FormValue("name")
	website := c.FormValue("website")
	commentContent := c.FormValue("comment")
	// TODO: give better error messages
	if emailAddress == "" {
		return c.Render(http.StatusBadRequest, "error-badrequest", nil)
	}
	if commentContent == "" {
		return c.Render(http.StatusBadRequest, "error-badrequest", nil)
	}
	userFound := lang.IfElse(userFoundError == nil, true, false)
	if commentIdString != "" {
		comment := domain.Comment{}
		commentId, err := strconv.Atoi(commentIdString)
		if err == nil {
			comment, err = controller.Store.GetComment(commentId)
			if err != nil {
				if errors.Is(err, lang.ErrNotFound) {
					return c.Render(http.StatusNotFound, "error-notfound", nil)
				} else {
					return sendInternalError(c, err)
				}
			}
		} else {
			return c.Render(http.StatusNotFound, "error-notfound", nil)
		}
		// we are editing a comment, verify that the user is allowed to do so
		if !userFound || comment.UserId != user.Id {
			return c.Render(http.StatusUnauthorized, "error-unauthorized", nil)
		}
		err = controller.Store.UpdateComment(comment.Id, comment.Status, commentContent, name, website)
		if err != nil {
			return sendInternalError(c, err)
		}
		return c.Redirect(http.StatusFound, "/services/"+serviceKey+"/posts/"+postKey+"/comments/"+strconv.Itoa(comment.Id))

	} else {
		service, err := controller.Store.GetServiceForKey(serviceKey)
		if err != nil {
			return sendInternalError(c, err)
		}
		commentStatus := lang.IfElse(userFound, domain.PendingApproval, domain.PendingAuthentication)
		commentId, err := controller.Store.CreateComment(
			commentStatus, service.Id, user.Id, postKey, commentContent, name, website)
		if err != nil {
			return sendInternalError(c, err)
		}
		return c.Redirect(http.StatusFound, "/services/"+serviceKey+"/posts/"+postKey+"/comments/"+strconv.Itoa(commentId))
	}
}
