package server

import (
	"aggregat4/go-commentservice/internal/domain"
	"aggregat4/go-commentservice/internal/repository"
	"embed"
	"html/template"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	baselibmiddleware "github.com/aggregat4/go-baselib-services/v3/middleware"
	baseliboidc "github.com/aggregat4/go-baselib-services/v3/oidc"
	"github.com/aggregat4/go-baselib/lang"
	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/gorilla/sessions"
	"github.com/labstack/echo-contrib/session"
	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
	"github.com/pkg/errors"
)

var logger = slog.New(slog.NewTextHandler(os.Stdout, nil))

//go:embed public/views/*.html public/views/components/*.html
var viewTemplates embed.FS

//go:embed public/js/*.js
var javaScript embed.FS

//go:embed public/css/*.css
var styleSheets embed.FS

var templateStylesheets = []string{"css/main.css"}
var templateScripts = []string{"js/components.js", "js/formatting.js"}

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
	// Initialize static assets
	if err := initializeStaticAssets(javaScript, "js"); err != nil {
		logger.Error("Failed to initialize JavaScript assets", "error", err)
	}
	if err := initializeStaticAssets(styleSheets, "css"); err != nil {
		logger.Error("Failed to initialize CSS assets", "error", err)
	}

	oidcMiddleware := baseliboidc.NewOidcMiddleware(
		controller.Config.OidcIdpServer,
		controller.Config.OidcClientId,
		controller.Config.OidcClientSecret,
		controller.Config.OidcRedirectUri,
		func(c echo.Context) bool {
			// We want authentication on admin and user endpoints
			return !strings.HasPrefix(c.Path(), "/admin") && !strings.HasPrefix(c.Path(), "/users/")
		})
	oidcCallback := oidcMiddleware.CreateOidcCallbackEndpoint(
		baseliboidc.CreateSessionBasedOidcDelegate(
			func(c echo.Context, idToken *oidc.IDToken) error {
				return createSessionFromIDToken(c, idToken, &controller)
			},
			"/",
		))
	return InitServerWithOidcMiddleware(
		controller,
		oidcMiddleware.CreateOidcMiddleware(func(c echo.Context) bool {
			// Skip OIDC if user already has either admin or regular user session
			_, adminErr := getAdminUserIdFromSession(c)
			if adminErr == nil {
				return true
			}
			_, userErr := getUserIdFromSession(c)
			return userErr == nil
		}),
		oidcCallback,
		true, // Enable CSRF for production
	)
}

func InitServerWithOidcMiddleware(
	controller Controller,
	oidcMiddleware echo.MiddlewareFunc,
	oidcCallback func(c echo.Context) error,
	enableCsrf bool,
) *echo.Echo {
	e := echo.New()

	// Set server timeouts based on advice from https://blog.cloudflare.com/the-complete-guide-to-golang-net-http-timeouts/#1687428081
	e.Server.ReadTimeout = time.Duration(controller.Config.ServerReadTimeoutSeconds) * time.Second
	e.Server.WriteTimeout = time.Duration(controller.Config.ServerWriteTimeoutSeconds) * time.Second

	var templateMap = map[string]*template.Template{
		"addeditcomment":       template.Must(template.New("").ParseFS(viewTemplates, "public/views/addeditcomment.html", "public/views/components/*.html")),
		"usercomments":         template.Must(template.New("").ParseFS(viewTemplates, "public/views/usercomments.html", "public/views/components/*.html")),
		"postcomments":         template.Must(template.New("").ParseFS(viewTemplates, "public/views/postcomments.html", "public/views/components/*.html")),
		"userlogin":            template.Must(template.New("").ParseFS(viewTemplates, "public/views/userlogin.html", "public/views/components/*.html")),
		"admin-dashboard":      template.Must(template.New("").ParseFS(viewTemplates, "public/views/admin-dashboard.html", "public/views/components/*.html")),
		"error-internalserver": template.Must(template.New("").ParseFS(viewTemplates, "public/views/error-internalserver.html", "public/views/components/*.html")),
		"error-notfound":       template.Must(template.New("").ParseFS(viewTemplates, "public/views/error-notfound.html", "public/views/components/*.html")),
		"error-unauthorized":   template.Must(template.New("").ParseFS(viewTemplates, "public/views/error-unauthorized.html", "public/views/components/*.html")),
		"error-badrequest":     template.Must(template.New("").ParseFS(viewTemplates, "public/views/error-badrequest.html", "public/views/components/*.html")),
		"error-forbidden":      template.Must(template.New("").ParseFS(viewTemplates, "public/views/error-forbidden.html", "public/views/components/*.html")),
		"superadmin-services":  template.Must(template.New("").ParseFS(viewTemplates, "public/views/superadmin-services.html", "public/views/components/*.html")),
		"demo":                 template.Must(template.New("").ParseFS(viewTemplates, "public/views/demo.html", "public/views/components/*.html")),
	}

	e.Renderer = &EchoTemplateRenderer{
		templates: templateMap,
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
	// User authentication is now handled by OIDC middleware
	// Set custom error handler
	e.HTTPErrorHandler = customHTTPErrorHandler
	// CSRF protection middleware (conditional)
	if enableCsrf {
		e.Use(baselibmiddleware.CsrfMiddleware)
	}
	// Endpoints
	// static assets
	e.GET("/js/*", hashedStaticHandler(javaScript, "js"))
	e.GET("/css/*", hashedStaticHandler(styleSheets, "css"))

	// infrastructure
	e.GET("/oidccallback", oidcCallback)
	e.GET("/status", controller.Status)

	// ---- UNAUTHENTICATED
	// Since we collect private data, we need to provide a GDPR compliant privacy policy
	// This should be configurable as the contents depend on the admin. Can we just serve a file?
	// TODO: e.GET("/privacypolicy", controller.PrivacyPolicy)
	// We can display all comments for a post
	e.GET("/services/:serviceKey/posts/:postKey/comments/", controller.GetComments)

	// ---- AUTHENTICATED WITH OIDC (normal user)
	// One can write a comment for a post, the comment form is prefilled if you are authenticated
	e.GET("/users/:userId/services/:serviceKey/posts/:postKey/commentform", controller.GetCommentForm)
	// One can add that comment to the post (in state unauthenticated, assuming we have all the info we need (at least email and content))
	e.POST("/users/:userId/services/:serviceKey/posts/:postKey/comments/", controller.PostComment)
	// Calling this page with a special parameter or content-type allows you to export the page as a json document
	e.GET("/users/:userId/comments/", controller.GetCommentsForUser)
	// Allow a user to modify his comment
	e.GET("/users/:userId/comments/:commentId/edit", controller.GetUserCommentForm)
	// Users can delete comments, this redirects back to the comment overview page
	e.POST("/users/:userId/comments/:commentId/delete", controller.DeleteUserComment)
	// Users can delete comments, this redirects back to the comment overview page
	// Users can update comments: see the PostComment route under /services/:serviceKey/posts/:postKey/comments

	// ---- AUTHENTICATED WITH OIDC AND ROLE admin-<servicekey> (service administrator)
	e.GET("/login", controller.GetUserLoginForm)
	e.GET("/admin", controller.GetAdminHome)
	// Service admin routes with middleware
	serviceAdmin := e.Group("/admin/:servicekey")
	serviceAdmin.Use(CreateServiceAdminAuthMiddleware())
	serviceAdmin.GET("/comments", controller.GetServiceAdminDashboard)
	serviceAdmin.POST("/comments/:commentId/approve", controller.ServiceAdminApproveComment)
	serviceAdmin.POST("/comments/:commentId/delete", controller.ServiceAdminDeleteComment)

	// ---- AUTHENTICATED WITH OIDC AND ROLE superadmin (super administrator)
	superAdmin := e.Group("/superadmin")
	superAdmin.Use(CreateSuperAdminAuthMiddleware())
	superAdmin.GET("/services", controller.GetSuperAdminServices)
	superAdmin.GET("/comments", controller.GetSuperAdminDashboard)

	// ---- DEMO ROUTES
	e.GET("/demo", controller.GetDemo)

	return e
}

// Update the error handlers to use templateData and include CSS
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
	case http.StatusForbidden:
		errorPageTemplate = "error-forbidden"
	}
	err = c.Render(code, errorPageTemplate, domain.ErrorPage{
		BasePage: domain.BasePage{
			Stylesheets: templateStylesheets,
			Scripts:     templateScripts,
		},
	})
	if err != nil {
		c.Logger().Error(err)
	}
}

// Update the GetComments handler
func (controller *Controller) GetComments(c echo.Context) error {
	user, err := getUserFromSession(c, controller)
	if err != nil && !errors.Is(err, lang.ErrNotFound) {
		return sendInternalError(c, err)
	}

	serviceKey := c.Param("serviceKey")
	postKey := c.Param("postKey")
	if serviceKey == "" || postKey == "" {
		return renderBadRequest(c)
	}
	service, err := controller.Store.GetServiceForKey(serviceKey)
	if err != nil {
		if errors.Is(err, lang.ErrNotFound) {
			return renderNotFound(c)
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
	// c.Response().Header().Set("Cache-Control", "public, max-age=60, stale-while-revalidate=300") // Cache for 1 minute, allow stale content for 5 minutes while revalidating
	return c.Render(http.StatusOK, "postcomments", domain.PostCommentsPage{
		BasePage: domain.BasePage{
			Stylesheets: templateStylesheets,
			Scripts:     templateScripts,
			Error:       errorFlashes,
			Success:     successFlashes,
		},
		User:       user,
		ServiceKey: serviceKey,
		PostKey:    postKey,
		Comments:   comments,
	})
}

func (controller *Controller) Status(c echo.Context) error {
	logger.Info("Status endpoint")
	return c.String(http.StatusOK, "OK")
}

func handleAuthenticationError(c echo.Context, err error) error {
	if errors.Is(err, lang.ErrNotFound) {
		return renderUnauthorized(c)
	} else {
		return sendInternalError(c, err)
	}
}

func (controller *Controller) GetCommentsForUser(c echo.Context) error {
	// validate that the userid in the url is the same as the userid in the session
	userIdString := c.Param("userId")
	userId, err := strconv.Atoi(userIdString)
	if err != nil {
		return renderBadRequest(c)
	}
	user, err := getUserFromSession(c, controller)
	if err != nil {
		return handleAuthenticationError(c, err)
	}
	if user.Id != userId {
		return renderUnauthorized(c)
	}
	comments, err := controller.Store.GetCommentsForUser(user.Id)
	if err != nil {
		return sendInternalError(c, err)
	}
	return c.Render(http.StatusOK, "usercomments", domain.UserCommentsPage{
		BasePage: domain.BasePage{
			Stylesheets: templateStylesheets,
			Scripts:     templateScripts,
		},
		User:     user,
		Comments: comments,
	})
}

func (controller *Controller) GetCommentForm(c echo.Context) error {
	serviceKey := c.Param("serviceKey")
	postKey := c.Param("postKey")
	if serviceKey == "" || postKey == "" {
		return renderBadRequest(c)
	}
	user, userFoundError := getUserFromSession(c, controller)
	if userFoundError != nil && !errors.Is(userFoundError, lang.ErrNotFound) {
		return sendInternalError(c, userFoundError)
	} else if userFoundError != nil {
		return renderUnauthorized(c)
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
				if comment.UserId != user.Id {
					return renderUnauthorized(c)
				}
				commentFound = true
			} else {
				return renderNotFound(c)
			}
		} else {
			return renderNotFound(c)
		}
	}
	service, err := controller.Store.GetServiceForKey(serviceKey)
	if err != nil {
		// TODO: better error to indicate that this service does not exist?
		return renderNotFound(c)
	}
	c.Response().Header().Set("Content-Security-Policy", "frame-ancestors "+service.Origin)
	return c.Render(http.StatusOK, "addeditcomment", domain.AddOrEditCommentPage{
		BasePage: domain.BasePage{
			Stylesheets: templateStylesheets,
			Scripts:     templateScripts,
		},
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
			return renderNotFound(c)
		} else {
			return sendInternalError(c, err)
		}
	}
	// NO CSP header to prevent embedding because this URL presupposes a logged in user and it can be called from
	// some general dashboard where a user can manage their comments
	return c.Render(http.StatusOK, "addeditcomment", domain.AddOrEditCommentPage{
		BasePage: domain.BasePage{
			Stylesheets: templateStylesheets,
			Scripts:     templateScripts,
		},
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
		return domain.User{}, domain.Comment{}, renderBadRequest(c)
	}
	userId, err := strconv.Atoi(userIdString)
	if err != nil {
		return domain.User{}, domain.Comment{}, renderBadRequest(c)
	}
	// validate user
	user, err := getUserFromSession(c, controller)
	if err != nil {
		if errors.Is(err, lang.ErrNotFound) {
			return domain.User{}, domain.Comment{}, renderUnauthorized(c)
		}
		return domain.User{}, domain.Comment{}, sendInternalError(c, err)
	}
	if user.Id != userId {
		return domain.User{}, domain.Comment{}, renderUnauthorized(c)
	}
	// retrieve comment
	comment, err := controller.requireCommentAndRetrieve(c)
	if err != nil {
		return domain.User{}, domain.Comment{}, handleCommonErrors(c, err)
	}
	if comment.UserId != user.Id {
		return domain.User{}, domain.Comment{}, renderUnauthorized(c)
	}
	return user, comment, nil
}

func handleCommonErrors(c echo.Context, err error) error {
	if errors.Is(err, lang.ErrNotFound) {
		return renderNotFound(c)
	} else if errors.Is(err, ErrIllegalArgument) {
		return renderBadRequest(c)
	} else {
		return sendInternalError(c, err)
	}
}

func (controller *Controller) PostComment(c echo.Context) error {
	// Validation
	serviceKey := c.Param("serviceKey")
	postKey := c.Param("postKey")
	if serviceKey == "" || postKey == "" {
		return renderBadRequest(c)
	}
	service, err := controller.Store.GetServiceForKey(serviceKey)
	if err != nil {
		return sendInternalError(c, err)
	}
	// Get user session if available
	user, userSessionError := getUserFromSession(c, controller)
	if userSessionError != nil && !errors.Is(userSessionError, lang.ErrNotFound) {
		return sendInternalError(c, userSessionError)
	}
	userAuthenticated := lang.IfElse(userSessionError == nil, true, false)
	if !userAuthenticated {
		return renderUnauthorized(c)
	}
	// Get form data
	commentIdString := c.FormValue("commentId")
	name := c.FormValue("name")
	website := c.FormValue("website")
	commentContent := c.FormValue("comment")
	parentUrl := c.FormValue("parentUrl")
	// TODO: give better error messages
	if commentContent == "" {
		return renderBadRequest(c)
	}
	if commentIdString != "" {
		// EDITING a comment
		comment := domain.Comment{}
		commentId, err := strconv.Atoi(commentIdString)
		if err == nil {
			comment, err = controller.Store.GetComment(commentId)
			if err != nil {
				if errors.Is(err, lang.ErrNotFound) {
					return renderNotFound(c)
				} else {
					return sendInternalError(c, err)
				}
			}
		} else {
			return renderNotFound(c)
		}
		// we are editing a comment, verify that the user is allowed to do so
		if comment.UserId != user.Id {
			return renderUnauthorized(c)
		}
		// prevent editing approved comments
		if comment.Status == domain.CommentStatusApproved {
			return renderUnauthorized(c)
		}
		err = controller.Store.UpdateComment(comment.Id, comment.Status, commentContent, name, website, parentUrl)
		if err != nil {
			return sendInternalError(c, err)
		}
		//nolint:errcheck
		baseliboidc.SetFlash(c, "success", "Your comment has been updated")
		return c.Redirect(http.StatusFound, "/services/"+serviceKey+"/posts/"+postKey+"/comments/")

	} else {
		_, err = controller.Store.CreateComment(domain.CommentStatusPendingApproval, service.Id, service.ServiceKey, user.Id, postKey, commentContent, name, website, parentUrl)
		if err != nil {
			return sendInternalError(c, err)
		}
		//nolint:errcheck
		baseliboidc.SetFlash(c, "success", "Your comment has been added")
		return c.Redirect(http.StatusFound, "/services/"+serviceKey+"/posts/"+postKey+"/comments/")
	}
}

func (controller *Controller) GetUserLoginForm(c echo.Context) error {
	return c.Render(http.StatusOK, "userlogin", domain.BasePage{
		Stylesheets: templateStylesheets,
		Scripts:     templateScripts,
	})
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
		return c.Redirect(http.StatusUnauthorized, "/login/")
	}

	// Fetch comments for all services, depending on the showStatus parameter we filter the comments
	showStatusParam := c.QueryParam("showStatus")
	statuses := []domain.CommentStatus{}
	if showStatusParam != "" {
		for status := range strings.SplitSeq(showStatusParam, ",") {
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

	var templateData = domain.AdminDashboardPage{
		BasePage: domain.BasePage{
			Stylesheets: templateStylesheets,
			Scripts:     templateScripts,
			Error:       errorFlashes,
			Success:     successFlashes,
		},
		AdminUser: domain.AdminUser{UserId: adminUserId},
		Comments:  comments,
		Statuses:  statuses,
	}
	// Prepare data for the dashboard
	return c.Render(http.StatusOK, "admin-dashboard", templateData)
}

func (controller *Controller) AdminApproveComment(c echo.Context) error {
	_, err := getAdminUserIdFromSession(c)
	if err != nil && !errors.Is(err, lang.ErrNotFound) {
		return sendInternalError(c, err)
	} else if err != nil {
		return c.Redirect(http.StatusUnauthorized, "/login/")
	}
	comment, err := controller.requireCommentAndRetrieve(c)
	if err != nil {
		return handleCommonErrors(c, err)
	}
	err = controller.Store.UpdateComment(comment.Id, domain.CommentStatusApproved, comment.Comment, comment.Name, comment.Website, comment.ParentUrl)
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
		return c.Redirect(http.StatusUnauthorized, "/login/")
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

func (controller *Controller) GetServiceAdminDashboard(c echo.Context) error {
	adminUser, err := getAdminUserFromSession(c)
	if err != nil {
		return sendInternalError(c, err)
	}

	serviceKey := c.Param("servicekey")

	// Fetch comments for specific service, depending on the showStatus parameter we filter the comments
	showStatusParam := c.QueryParam("showStatus")
	statuses := []domain.CommentStatus{}
	if showStatusParam != "" {
		for status := range strings.SplitSeq(showStatusParam, ",") {
			parsedStatus, err := domain.ParseCommentStatus(status)
			if err != nil {
				return c.Redirect(http.StatusBadRequest, "/admin/"+serviceKey+"/comments")
			}
			statuses = append(statuses, parsedStatus)
		}
	}
	comments, err := controller.Store.GetCommentsByServiceAndStatus(serviceKey, statuses)
	if err != nil {
		return sendInternalError(c, err)
	}

	// Get flash messages
	successFlashes, errorFlashes, err := baseliboidc.GetFlashes(c)
	if err != nil {
		return sendInternalError(c, err)
	}

	var templateData = domain.AdminDashboardPage{
		BasePage: domain.BasePage{
			Stylesheets: templateStylesheets,
			Scripts:     templateScripts,
			Error:       errorFlashes,
			Success:     successFlashes,
		},
		AdminUser: adminUser,
		Comments:  comments,
		Statuses:  statuses,
	}
	return c.Render(http.StatusOK, "admin-dashboard", templateData)
}

func (controller *Controller) ServiceAdminApproveComment(c echo.Context) error {
	_, err := getAdminUserFromSession(c)
	if err != nil {
		return sendInternalError(c, err)
	}

	serviceKey := c.Param("servicekey")
	comment, err := controller.requireCommentAndRetrieve(c)
	if err != nil {
		return handleCommonErrors(c, err)
	}

	// Verify comment belongs to the service
	if comment.ServiceKey != serviceKey {
		return renderForbidden(c)
	}

	err = controller.Store.UpdateComment(comment.Id, domain.CommentStatusApproved, comment.Comment, comment.Name, comment.Website, comment.ParentUrl)
	if err != nil {
		return sendInternalError(c, err)
	}
	return c.Redirect(http.StatusFound, "/admin/"+serviceKey+"/comments")
}

func (controller *Controller) ServiceAdminDeleteComment(c echo.Context) error {
	_, err := getAdminUserFromSession(c)
	if err != nil {
		return sendInternalError(c, err)
	}

	serviceKey := c.Param("servicekey")
	comment, err := controller.requireCommentAndRetrieve(c)
	if err != nil {
		return handleCommonErrors(c, err)
	}

	// Verify comment belongs to the service
	if comment.ServiceKey != serviceKey {
		return renderForbidden(c)
	}

	err = controller.Store.DeleteComment(comment.Id)
	if err != nil {
		return sendInternalError(c, err)
	}
	return c.Redirect(http.StatusFound, "/admin/"+serviceKey+"/comments")
}

func (controller *Controller) GetSuperAdminServices(c echo.Context) error {
	adminUser, err := getAdminUserFromSession(c)
	if err != nil {
		return sendInternalError(c, err)
	}

	services, err := controller.Store.GetAllServices()
	if err != nil {
		return sendInternalError(c, err)
	}

	// Get flash messages
	successFlashes, errorFlashes, err := baseliboidc.GetFlashes(c)
	if err != nil {
		return sendInternalError(c, err)
	}

	var templateData = struct {
		domain.BasePage
		AdminUser domain.AdminUser
		Services  []domain.Service
	}{
		BasePage: domain.BasePage{
			Stylesheets: templateStylesheets,
			Scripts:     templateScripts,
			Error:       errorFlashes,
			Success:     successFlashes,
		},
		AdminUser: adminUser,
		Services:  services,
	}
	return c.Render(http.StatusOK, "superadmin-services", templateData)
}

func (controller *Controller) GetSuperAdminDashboard(c echo.Context) error {
	adminUser, err := getAdminUserFromSession(c)
	if err != nil {
		return sendInternalError(c, err)
	}

	// Fetch comments for all services, depending on the showStatus parameter we filter the comments
	showStatusParam := c.QueryParam("showStatus")
	statuses := []domain.CommentStatus{}
	if showStatusParam != "" {
		for status := range strings.SplitSeq(showStatusParam, ",") {
			parsedStatus, err := domain.ParseCommentStatus(status)
			if err != nil {
				return c.Redirect(http.StatusBadRequest, "/superadmin/comments")
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

	var templateData = domain.AdminDashboardPage{
		BasePage: domain.BasePage{
			Stylesheets: templateStylesheets,
			Scripts:     templateScripts,
			Error:       errorFlashes,
			Success:     successFlashes,
		},
		AdminUser: adminUser,
		Comments:  comments,
		Statuses:  statuses,
	}
	return c.Render(http.StatusOK, "admin-dashboard", templateData)
}

func (controller *Controller) GetDemo(c echo.Context) error {
	user, err := getUserFromSession(c, controller)
	if err != nil && !errors.Is(err, lang.ErrNotFound) {
		return sendInternalError(c, err)
	}
	return c.Render(http.StatusOK, "demo", domain.DemoPage{
		BasePage: domain.BasePage{
			Stylesheets: templateStylesheets,
			Scripts:     templateScripts,
		},
		User: user,
	})
}
