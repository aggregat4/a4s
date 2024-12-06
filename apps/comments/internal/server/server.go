package server

import (
	"aggregat4/go-commentservice/internal/domain"
	"aggregat4/go-commentservice/internal/email"
	"aggregat4/go-commentservice/internal/repository"
	"embed"
	"errors"
	"html/template"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	baseliboidc "github.com/aggregat4/go-baselib-services/v3/oidc"
	"github.com/aggregat4/go-baselib/lang"
	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/google/uuid"
	"github.com/gorilla/sessions"
	"github.com/labstack/echo-contrib/session"
	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
)

var logger = slog.New(slog.NewTextHandler(os.Stdout, nil))

//go:embed public/views/*.html
var viewTemplates embed.FS

//go:embed public/js/*.js
var javaScript embed.FS

//go:embed public/css/*.css
var styleSheets embed.FS

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
			// We only want authentication on admin endpoints
			return !strings.HasPrefix(c.Path(), "/admin")
		})
	oidcCallback := oidcMiddleware.CreateOidcCallbackEndpoint(
		baseliboidc.CreateSessionBasedOidcDelegate(
			func(c echo.Context, idToken *oidc.IDToken) error {
				return createAdminSessionCookie(c, idToken.Subject)
			},
			"/admin", // TODO: change fallback URI
		))
	return InitServerWithOidcMiddleware(
		controller,
		oidcMiddleware.CreateOidcMiddleware(func(c echo.Context) bool {
			_, err := getAdminUserIdFromSession(c)
			return err == nil
		}),
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
	e.Use(httpResponseLogger)
	e.Use(middleware.Recover())
	sessionCookieSecretKey := controller.Config.SessionCookieSecretKey
	cookieStore := sessions.NewCookieStore([]byte(sessionCookieSecretKey))
	cookieStore.Options = &sessions.Options{
		Path:     "/",
		MaxAge:   controller.Config.SessionCookieCookieMaxAge,
		Secure:   controller.Config.SessionCookieSecureFlag,
		HttpOnly: true,
		SameSite: domain.SameSiteFromString(controller.Config.SessionCookieCookieSameSite),
	}

	e.Use(session.Middleware(cookieStore))
	e.Use(middleware.GzipWithConfig(middleware.GzipConfig{Level: 5}))
	// user authentication is required for pages related to a user's comments
	e.Use(oidcMiddleware)
	e.Use(CreateUserAuthenticationMiddleware(func(c echo.Context) bool {
		return !strings.HasPrefix(c.Path(), "/users/")
	}))
	// Set custom error handler
	e.HTTPErrorHandler = customHTTPErrorHandler
	// CSRF protection middleware
	e.Use(csrfMiddleware)

	// Endpoints
	// static assets
	javaScriptFS := echo.MustSubFS(javaScript, "public/js")
	e.StaticFS("/js", javaScriptFS)
	styleSheetsFS := echo.MustSubFS(styleSheets, "public/css")
	e.StaticFS("/css", styleSheetsFS)
	// infrastructure
	e.GET("/oidccallback", oidcCallback)
	// ---- UNAUTHENTICATED
	// Status endpoint
	e.GET("/status", controller.Status)
	// Since we collect private data, we need to provide a GDPR compliant privacy policy
	// This should be configurable as the contents depend on the admin. Can we just serve a file?
	// TODO: e.GET("/privacypolicy", controller.PrivacyPolicy)
	// We can display all comments for a post
	e.GET("/services/:serviceKey/posts/:postKey/comments/", controller.GetComments)
	// One can write a comment for a post, the comment form is prefilled if you are authenticated
	e.GET("/services/:serviceKey/posts/:postKey/commentform", controller.GetCommentForm)
	// One can add that comment to the post (in state unauthenticated, assuming we have all the info we need (at least email and content))
	e.POST("/services/:serviceKey/posts/:postKey/comments/", controller.PostComment)
	// ----- User Authentication
	// If users are not authenticated (we check a cookie) then we redirect them to a page where they can request an authentication link
	// This is just the "userauthentication" endpoint without a token, it has a form where you can enter your email address
	e.GET("/userauthentication/", controller.GetUserAuthenticationForm)
	// Users can submit a userauthentication form to get a new token sent
	e.POST("/userauthentication/", controller.RequestAuthenticationLink)
	// Users can authenticate by clicking on an authentication link sent by email, this has to be GET because email
	e.GET("/userauthentication/:token", controller.AuthenticateUser)
	// After authenticating the user:
	// 1. sets a cookie with the userId
	// 2. redirects to a user's comment overview and management page
	// ---- AUTHENTICATED WITH AUTH TOKEN (normal user)
	// Calling this page with a special parameter or content-type allows you to export the page as a json document
	e.GET("/users/:userId/comments/", controller.GetCommentsForUser)
	// Allow a user to modify his comment
	e.GET("/users/:userId/comments/:commentId/edit", controller.GetUserCommentForm)
	// Users can delete comments, this redirects back to the comment overview page
	e.POST("/users/:userId/comments/:commentId/delete", controller.DeleteUserComment)
	// Users can delete comments, this redirects back to the comment overview page
	e.POST("/users/:userId/comments/:commentId/confirm", controller.ConfirmUserComment)
	// Users can update comments: see the PostComment route under /services/:serviceKey/posts/:postKey/comments

	// ---- AUTHENTICATED WITH OIDC AND ROLE service-admin (admimistrator)
	e.GET("/adminlogin", controller.GetAdminLoginForm)
	e.GET("/admin", controller.GetAdminHome)
	e.GET("/admin/comments", controller.GetAdminDashboard)
	e.POST("/admin/comments/:commentId/approve", controller.AdminApproveComment)
	e.POST("/admin/comments/:commentId/delete", controller.AdminDeleteComment)

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
	successFlashes, errorFlashes, err := baseliboidc.GetFlashes(c)
	if err != nil {
		// TODO: consider not failing on just flash messages having an error, but also just log and ignore them
		return sendInternalError(c, err)
	}
	c.Response().Header().Set("Content-Security-Policy", "frame-ancestors "+service.Origin)
	return c.Render(http.StatusOK, "postcomments", domain.PostCommentsPage{
		ServiceKey: serviceKey,
		PostKey:    postKey,
		Comments:   comments,
		Error:      errorFlashes,
		Success:    successFlashes,
	})
}

func (controller *Controller) Status(c echo.Context) error {
	logger.Info("Status endpoint")
	return c.String(http.StatusOK, "OK")
}

func (controller *Controller) GetUserAuthenticationForm(c echo.Context) error {
	successFlashes, errorFlashes, err := baseliboidc.GetFlashes(c)
	if err != nil {
		return sendInternalError(c, err)
	}
	return c.Render(http.StatusOK, "userauthentication", domain.UserAuthenticationPage{
		EmailAddress: c.QueryParam("emailAddress"),
		Error:        errorFlashes,
		Success:      successFlashes,
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
			baseliboidc.SetFlash(c, "error", "No data was found for the user with email address '"+emailAddress+"'")
			return c.Redirect(http.StatusFound, "/userauthentication/")
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
		emailSuccessfullyQueued := controller.EmailSender.SendEmail(email.AuthenticationCodeEmail{
			EmailAddress: emailAddress,
			Code:         user.AuthToken,
		})
		if emailSuccessfullyQueued {
			if delay > 0 {
				baseliboidc.SetFlash(c, "success", "An authentication token will be sent in "+delay.String()+".")
			} else {
				baseliboidc.SetFlash(c, "success", "An authentication token is on the way, please check your email.")
			}
		} else {
			// TODO error message too vague?
			baseliboidc.SetFlash(c, "error", "Could not send an email at this time, please try again later.")
		}
		return c.Redirect(http.StatusFound, "/userauthentication/")
	} else {
		// let the user know they have to try again in 15 minutes
		baseliboidc.SetFlash(c, "error", "Too many attempts were made to login for this user. Please try again in 15 minutes.")
		return c.Redirect(http.StatusFound, "/userauthentication/")
	}
}

func (controller *Controller) AuthenticateUser(c echo.Context) error {
	token := c.Param("token")
	if token == "" {
		return c.Redirect(http.StatusFound, "/userauthentication/")
	}
	user, err := controller.Store.FindUserByAuthToken(token)
	if err != nil || !validToken(user) {
		baseliboidc.SetFlash(c, "error", "Invalid token")
		return c.Redirect(http.StatusFound, "/userauthentication/")
	}
	// This is a normal user, not an admin
	err = createUserSessionCookie(c, user.Id)
	if err != nil {
		return sendInternalError(c, err)
	}
	return c.Redirect(http.StatusFound, "/users/"+strconv.Itoa(user.Id)+"/comments/")
}

func handleAuthenticationError(c echo.Context, err error) error {
	if errors.Is(err, lang.ErrNotFound) {
		return c.Redirect(http.StatusFound, "/userauthentication/")
	} else {
		return sendInternalError(c, err)
	}
}

func (controller *Controller) GetCommentsForUser(c echo.Context) error {
	// validate that the userid in the url is the same as the userid in the session
	userIdString := c.Param("userId")
	userId, err := strconv.Atoi(userIdString)
	if err != nil {
		return c.Render(http.StatusBadRequest, "error-badrequest", nil)
	}
	user, err := getUserFromSession(c, controller)
	if err != nil {
		return handleAuthenticationError(c, err)
	}
	if user.Id != userId {
		return c.Render(http.StatusUnauthorized, "error-unauthorized", nil)
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
				userAuthenticated := lang.IfElse(userFoundError == nil, true, false)
				if !userAuthenticated || comment.UserId != user.Id {
					return c.Render(http.StatusUnauthorized, "error-unauthorized", nil)
				}
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
	if err != nil || !user.IsValid() {
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
	if err != nil || !user.IsValid() {
		return err
	}
	err = controller.Store.DeleteComment(comment.Id)
	if err != nil {
		if errors.Is(err, lang.ErrNotFound) {
			// TODO: toast to show that the comment has NOT been deleted
			return c.Redirect(http.StatusFound, "/users/"+strconv.Itoa(user.Id)+"/comments/")
		} else {
			return sendInternalError(c, err)
		}
	}
	// TODO: toast to show that the comment has been deleted
	return c.Redirect(http.StatusFound, "/users/"+strconv.Itoa(user.Id)+"/comments/")
}

func (controller *Controller) ConfirmUserComment(c echo.Context) error {
	user, comment, err := controller.extractAndValidateUserAndCommentFromRequest(c)
	if err != nil || !user.IsValid() {
		return err
	}
	if comment.Status != domain.CommentStatusPendingAuthentication {
		// TODO: return to original page and show toast to indicate that the comment is not pending authentication
		return c.Redirect(http.StatusFound, "/users/"+strconv.Itoa(user.Id)+"/comments/")
	}
	err = controller.Store.UpdateComment(comment.Id, domain.CommentStatusPendingApproval, comment.Comment, comment.Name, comment.Website)
	if err != nil {
		if errors.Is(err, lang.ErrNotFound) {
			// TODO: toast to show that the comment could not be found for confirmation
			return c.Redirect(http.StatusFound, "/users/"+strconv.Itoa(user.Id)+"/comments/")
		} else {
			return sendInternalError(c, err)
		}
	}
	return c.Redirect(http.StatusFound, "/users/"+strconv.Itoa(user.Id)+"/comments/")
}

func (controller *Controller) requireCommentAndRetrieve(c echo.Context) (domain.Comment, error) {
	commentIdString := c.Param("commentId")
	if commentIdString == "" {
		return domain.Comment{}, ErrIllegalArgument
	}
	commentId, err := strconv.Atoi(commentIdString)
	if err != nil {
		return domain.Comment{}, ErrIllegalArgument
	}
	return controller.Store.GetComment(commentId)
}

func (controller *Controller) extractAndValidateUserAndCommentFromRequest(c echo.Context) (domain.User, domain.Comment, error) {
	// resolve and validate user
	userIdString := c.Param("userId")
	if userIdString == "" {
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
	comment, err := controller.requireCommentAndRetrieve(c)
	if err != nil {
		return domain.User{}, domain.Comment{}, handleCommonErrors(c, err)
	}
	if comment.UserId != user.Id {
		return domain.User{}, domain.Comment{}, c.Render(http.StatusUnauthorized, "error-unauthorized", nil)
	}
	return user, comment, nil
}

func handleCommonErrors(c echo.Context, err error) error {
	if errors.Is(err, lang.ErrNotFound) {
		return c.Render(http.StatusNotFound, "error-notfound", nil)
	} else if errors.Is(err, ErrIllegalArgument) {
		return c.Render(http.StatusBadRequest, "error-badrequest", nil)
	} else {
		return sendInternalError(c, err)
	}
}

func (controller *Controller) PostComment(c echo.Context) error {
	serviceKey := c.Param("serviceKey")
	postKey := c.Param("postKey")
	if serviceKey == "" || postKey == "" {
		return c.Render(http.StatusBadRequest, "error-badrequest", nil)
	}
	user, userSessionError := getUserFromSession(c, controller)
	if userSessionError != nil && !errors.Is(userSessionError, lang.ErrNotFound) {
		return sendInternalError(c, userSessionError)
	}
	commentIdString := c.FormValue("commentId")
	emailAddress := c.FormValue("email")
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
	userAuthenticated := lang.IfElse(userSessionError == nil, true, false)
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
		if !userAuthenticated || comment.UserId != user.Id {
			return c.Render(http.StatusUnauthorized, "error-unauthorized", nil)
		}
		err = controller.Store.UpdateComment(comment.Id, comment.Status, commentContent, name, website)
		if err != nil {
			return sendInternalError(c, err)
		}
		baseliboidc.SetFlash(c, "success", "Your comment has been updated")
		return c.Redirect(http.StatusFound, "/services/"+serviceKey+"/posts/"+postKey+"/comments/")

	} else {
		// This is a new comment, if the user is not authenticated we create a new user and store the comment as pending authentication
		service, err := controller.Store.GetServiceForKey(serviceKey)
		if err != nil {
			return sendInternalError(c, err)
		}
		// find or create a user
		var userId int
		if !userAuthenticated {
			user, err := controller.Store.FindUserByEmail(emailAddress)
			if err == nil {
				// we found an existing user
				userId = user.Id
			} else if errors.Is(err, lang.ErrNotFound) {
				// we need to create a new user
				userId, err = controller.Store.CreateUserByEmail(emailAddress)
				if err != nil {
					return sendInternalError(c, err)
				}
			} else {
				return sendInternalError(c, err)
			}
		} else {
			userId = user.Id
		}
		commentStatus := lang.IfElse(userAuthenticated, domain.CommentStatusPendingApproval, domain.CommentStatusPendingAuthentication)
		_, err = controller.Store.CreateComment(
			commentStatus, service.Id, userId, postKey, commentContent, name, website)
		if err != nil {
			return sendInternalError(c, err)
		}
		baseliboidc.SetFlash(c, "success", "Your comment has been added")
		return c.Redirect(http.StatusFound, "/services/"+serviceKey+"/posts/"+postKey+"/comments/")
	}
}

func (controller *Controller) GetAdminLoginForm(c echo.Context) error {
	return c.Render(http.StatusOK, "adminlogin", nil)
}

func (controller *Controller) GetAdminHome(c echo.Context) error {
	return c.Redirect(http.StatusFound, "/admin/comments")
}

// Service administrators can access a service comment dashboard where they can approve or deny comments
// They require successful OIDC authentication and they require the "service-admin" value as part of the values
// in the "roles" claim. In the current model the admin is admin over all services on this server.
// We need to store not only the user Id but also the admin claims in his cookie here so we can always verify he or she has access
// to the particular service
// Don't show unauthenticated comments by default
func (controller *Controller) GetAdminDashboard(c echo.Context) error {
	adminUserId, err := getAdminUserIdFromSession(c)
	if err != nil && !errors.Is(err, lang.ErrNotFound) {
		return sendInternalError(c, err)
	} else if err != nil {
		return c.Redirect(http.StatusUnauthorized, "/adminlogin/")
	}

	// Fetch comments for all services, depending on the showStatus parameter we filter the comments
	showStatusParam := c.QueryParam("showStatus")
	statuses := []domain.CommentStatus{}
	if showStatusParam != "" {
		for _, status := range strings.Split(showStatusParam, ",") {
			parsedStatus, err := domain.ParseCommentStatus(status)
			if err != nil {
				return c.Redirect(http.StatusBadRequest, "/admin")
			}
			statuses = append(statuses, parsedStatus)
		}
	}
	comments, err := controller.Store.GetCommentsByStatus(statuses)
	if err != nil {
		return sendInternalError(c, err)
	}

	// Get flash messages
	successFlashes, errorFlashes, err := baseliboidc.GetFlashes(c)
	if err != nil {
		return sendInternalError(c, err)
	}

	// Prepare data for the dashboard
	dashboardData := domain.AdminDashboardPage{
		AdminUser: domain.AdminUser{UserId: adminUserId},
		Comments:  comments,
		Statuses:  statuses,
		Success:   successFlashes,
		Error:     errorFlashes,
	}

	return c.Render(http.StatusOK, "admin-dashboard", dashboardData)
}

func (controller *Controller) AdminApproveComment(c echo.Context) error {
	_, err := getAdminUserIdFromSession(c)
	if err != nil && !errors.Is(err, lang.ErrNotFound) {
		return sendInternalError(c, err)
	} else if err != nil {
		return c.Redirect(http.StatusUnauthorized, "/adminlogin/")
	}
	comment, err := controller.requireCommentAndRetrieve(c)
	if err != nil {
		return handleCommonErrors(c, err)
	}
	err = controller.Store.UpdateComment(comment.Id, domain.CommentStatusApproved, comment.Comment, comment.Name, comment.Website)
	if err != nil {
		return sendInternalError(c, err)
	}
	return c.Redirect(http.StatusFound, "/admin")
}

func (controller *Controller) AdminDeleteComment(c echo.Context) error {
	_, err := getAdminUserIdFromSession(c)
	if err != nil && !errors.Is(err, lang.ErrNotFound) {
		return sendInternalError(c, err)
	} else if err != nil {
		return c.Redirect(http.StatusUnauthorized, "/adminlogin/")
	}
	comment, err := controller.requireCommentAndRetrieve(c)
	if err != nil {
		return handleCommonErrors(c, err)
	}
	err = controller.Store.DeleteComment(comment.Id)
	if err != nil {
		return sendInternalError(c, err)
	}
	return c.Redirect(http.StatusFound, "/admin")
}

func customHTTPErrorHandler(err error, c echo.Context) {
	code := http.StatusInternalServerError
	if he, ok := err.(*echo.HTTPError); ok {
		code = he.Code
	}
	var errorPageTemplate = "error-internalserver"
	switch code {
	case http.StatusNotFound:
		errorPageTemplate = "error-notfound"
	case http.StatusUnauthorized:
		errorPageTemplate = "error-unauthorized"
	case http.StatusBadRequest:
		errorPageTemplate = "error-badrequest"
	}
	err = c.Render(code, errorPageTemplate, nil)
	if err != nil {
		c.Logger().Error(err)
	}
}
