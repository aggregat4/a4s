package server

import (
	"aggregat4/go-commentservice/internal/domain"
	"aggregat4/go-commentservice/internal/repository"
	"embed"
	"errors"
	"html/template"
	"net/http"
	"strconv"
	"strings"
	"time"

	baselibmiddleware "github.com/aggregat4/go-baselib-services/v4/middleware"
	baseliboidc "github.com/aggregat4/go-baselib-services/v4/oidc"
	"github.com/aggregat4/go-baselib/lang"
	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/go-chi/chi/v5"
	chimiddleware "github.com/go-chi/chi/v5/middleware"
	"github.com/gorilla/sessions"
	"github.com/willibrandon/mtlog"
	"github.com/willibrandon/mtlog/core"
)

var logger = mtlog.New(
	mtlog.WithConsole(),
	mtlog.WithMinimumLevel(core.InformationLevel),
)

//go:embed public/views/*.html public/views/components/*.html
var viewTemplates embed.FS

//go:embed public/js/*.js
var javaScript embed.FS

//go:embed public/css/*.css
var styleSheets embed.FS

var templateStylesheets = []string{"css/main.css"}
var templateScripts = []string{"js/components.js", "js/formatting.js"}

type Controller struct {
	Store        *repository.Store
	Config       domain.Config
	sessionStore *sessions.CookieStore
	flashStore   *sessions.CookieStore
	renderer     *TemplateRenderer
}

func RunServer(controller Controller) {
	httpServer := InitServer(&controller)
	logger.Info("Starting HTTP server on port {port}", controller.Config.Port)
	if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		logger.Fatal("Server failed: {err}", err)
	}
}

func InitServer(controller *Controller) *http.Server {
	if err := initializeStaticAssets(javaScript, "js"); err != nil {
		logger.Error("Failed to initialize JavaScript assets: {err}", err)
	}
	if err := initializeStaticAssets(styleSheets, "css"); err != nil {
		logger.Error("Failed to initialize CSS assets: {err}", err)
	}

	oidcConfig := baseliboidc.CreateOidcConfiguration(
		controller.Config.OidcIdpServer,
		controller.Config.OidcClientId,
		controller.Config.OidcClientSecret,
		controller.Config.OidcRedirectUri,
	)

	oidcMiddleware := oidcConfig.CreateOidcAuthenticationMiddleware(
		func(r *http.Request) bool {
			if _, err := controller.getAdminUserIdFromSession(r); err == nil {
				return true
			}
			_, err := controller.getUserIdFromSession(r)
			return err == nil
		},
		func(r *http.Request) bool {
			return !strings.HasPrefix(r.URL.Path, "/admin")
		},
	)

	oidcCallback := oidcConfig.CreateOidcCallbackHandler(
		baseliboidc.CreateSTDSessionBasedOidcDelegate(
			func(w http.ResponseWriter, r *http.Request, idToken *oidc.IDToken) error {
				return createSessionFromIDToken(w, r, controller, idToken)
			},
			"/",
		),
	)

	return InitServerWithOidcMiddleware(controller, oidcMiddleware, oidcCallback, true)
}

func InitServerWithOidcMiddleware(
	controller *Controller,
	oidcMiddleware func(http.Handler) http.Handler,
	oidcCallback http.HandlerFunc,
	enableCsrf bool,
) *http.Server {
	controller.initializeSessionStores()

	templateMap := map[string]*template.Template{
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
	controller.renderer = &TemplateRenderer{templates: templateMap}

	router := chi.NewRouter()
	router.Use(chimiddleware.RequestID)
	router.Use(chimiddleware.RealIP)
	router.Use(chimiddleware.Recoverer)
	router.Use(chimiddleware.Compress(5))
	router.Use(httpResponseLogger)
	router.Use(oidcMiddleware)

	if enableCsrf {
		router.Use(baselibmiddleware.CsrfMiddlewareStd)
	}

	router.Get("/js/*", hashedStaticHandler(javaScript, "js"))
	router.Get("/css/*", hashedStaticHandler(styleSheets, "css"))
	router.Get("/oidccallback", oidcCallback)
	router.Get("/status", controller.Status)

	router.Get("/services/{serviceKey}/posts/{postKey}/comments/", controller.GetComments)
	router.Get("/users/{userId}/services/{serviceKey}/posts/{postKey}/commentform", controller.GetCommentForm)
	router.Post("/users/{userId}/services/{serviceKey}/posts/{postKey}/comments/", controller.PostComment)
	router.Get("/users/{userId}/comments/", controller.GetCommentsForUser)
	router.Get("/users/{userId}/comments/{commentId}/edit", controller.GetUserCommentForm)
	router.Post("/users/{userId}/comments/{commentId}/delete", controller.DeleteUserComment)

	router.Get("/login", controller.GetUserLoginForm)
	router.Get("/admin", controller.GetAdminHome)

	router.Route("/admin/{servicekey}", func(r chi.Router) {
		r.Use(controller.serviceAdminAuthMiddleware)
		r.Get("/comments", controller.GetServiceAdminDashboard)
		r.Post("/comments/{commentId}/approve", controller.ServiceAdminApproveComment)
		r.Post("/comments/{commentId}/delete", controller.ServiceAdminDeleteComment)
	})

	router.Route("/superadmin", func(r chi.Router) {
		r.Use(controller.superAdminAuthMiddleware)
		r.Get("/services", controller.GetSuperAdminServices)
		r.Get("/comments", controller.GetSuperAdminDashboard)
	})

	router.Get("/demo", controller.GetDemo)

	router.NotFound(func(w http.ResponseWriter, r *http.Request) {
		controller.renderNotFound(w)
	})

	router.MethodNotAllowed(func(w http.ResponseWriter, r *http.Request) {
		controller.renderBadRequest(w)
	})

	server := &http.Server{
		Addr:         ":" + strconv.Itoa(controller.Config.Port),
		Handler:      router,
		ReadTimeout:  time.Duration(controller.Config.ServerReadTimeoutSeconds) * time.Second,
		WriteTimeout: time.Duration(controller.Config.ServerWriteTimeoutSeconds) * time.Second,
	}

	return server
}

func (controller *Controller) GetComments(w http.ResponseWriter, r *http.Request) {
	user, err := controller.getUserFromSession(r)
	if err != nil && !errors.Is(err, lang.ErrNotFound) {
		controller.sendInternalError(w, err)
		return
	}

	serviceKey := chi.URLParam(r, "serviceKey")
	postKey := chi.URLParam(r, "postKey")
	if serviceKey == "" || postKey == "" {
		controller.renderBadRequest(w)
		return
	}

	service, err := controller.Store.GetServiceForKey(serviceKey)
	if err != nil {
		if errors.Is(err, lang.ErrNotFound) {
			controller.renderNotFound(w)
		} else {
			controller.sendInternalError(w, err)
		}
		return
	}

	comments, err := controller.Store.GetCommentsForPost(service.Id, postKey)
	if err != nil {
		controller.sendInternalError(w, err)
		return
	}

	successFlashes, errorFlashes, err := controller.getFlashes(w, r)
	if err != nil {
		controller.sendInternalError(w, err)
		return
	}

	w.Header().Set("Content-Security-Policy", "frame-ancestors "+service.Origin)

	controller.renderTemplate(w, http.StatusOK, "postcomments", domain.PostCommentsPage{
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

func (controller *Controller) Status(w http.ResponseWriter, r *http.Request) {
	logger.Info("Status endpoint")
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("OK"))
}

func handleAuthenticationError(controller *Controller, w http.ResponseWriter, err error) {
	if errors.Is(err, lang.ErrNotFound) {
		controller.renderUnauthorized(w)
		return
	}
	controller.sendInternalError(w, err)
}

func (controller *Controller) GetCommentsForUser(w http.ResponseWriter, r *http.Request) {
	userIdString := chi.URLParam(r, "userId")
	userId, err := strconv.Atoi(userIdString)
	if err != nil {
		controller.renderBadRequest(w)
		return
	}

	user, err := controller.getUserFromSession(r)
	if err != nil {
		handleAuthenticationError(controller, w, err)
		return
	}

	if user.Id != userId {
		controller.renderUnauthorized(w)
		return
	}

	comments, err := controller.Store.GetCommentsForUser(user.Id)
	if err != nil {
		controller.sendInternalError(w, err)
		return
	}

	controller.renderTemplate(w, http.StatusOK, "usercomments", domain.UserCommentsPage{
		BasePage: domain.BasePage{
			Stylesheets: templateStylesheets,
			Scripts:     templateScripts,
		},
		User:     user,
		Comments: comments,
	})
}

func (controller *Controller) GetCommentForm(w http.ResponseWriter, r *http.Request) {
	serviceKey := chi.URLParam(r, "serviceKey")
	postKey := chi.URLParam(r, "postKey")
	if serviceKey == "" || postKey == "" {
		controller.renderBadRequest(w)
		return
	}

	user, userErr := controller.getUserFromSession(r)
	if userErr != nil && !errors.Is(userErr, lang.ErrNotFound) {
		controller.sendInternalError(w, userErr)
		return
	}

	commentIDParam := r.URL.Query().Get("commentId")
	commentFound := false
	comment := domain.Comment{}

	if commentIDParam != "" && userErr == nil {
		commentID, err := strconv.Atoi(commentIDParam)
		if err != nil {
			controller.renderNotFound(w)
			return
		}
		comment, err = controller.Store.GetComment(commentID)
		if err != nil {
			if errors.Is(err, lang.ErrNotFound) {
				controller.renderNotFound(w)
			} else {
				controller.sendInternalError(w, err)
			}
			return
		}
		if comment.UserId != user.Id {
			controller.renderUnauthorized(w)
			return
		}
		commentFound = true
	}

	service, err := controller.Store.GetServiceForKey(serviceKey)
	if err != nil {
		if errors.Is(err, lang.ErrNotFound) {
			controller.renderNotFound(w)
		} else {
			controller.sendInternalError(w, err)
		}
		return
	}

	w.Header().Set("Content-Security-Policy", "frame-ancestors "+service.Origin)

	controller.renderTemplate(w, http.StatusOK, "addeditcomment", domain.AddOrEditCommentPage{
		BasePage: domain.BasePage{
			Stylesheets: templateStylesheets,
			Scripts:     templateScripts,
		},
		ServiceKey:   serviceKey,
		PostKey:      postKey,
		UserFound:    userErr == nil,
		User:         user,
		CommentFound: commentFound,
		Comment:      comment,
	})
}

func (controller *Controller) GetUserCommentForm(w http.ResponseWriter, r *http.Request) {
	user, comment, ok := controller.extractAndValidateUserAndCommentFromRequest(w, r)
	if !ok {
		return
	}

	service, err := controller.Store.FindServiceById(comment.ServiceId)
	if err != nil {
		if errors.Is(err, lang.ErrNotFound) {
			controller.renderNotFound(w)
		} else {
			controller.sendInternalError(w, err)
		}
		return
	}

	controller.renderTemplate(w, http.StatusOK, "addeditcomment", domain.AddOrEditCommentPage{
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

func (controller *Controller) DeleteUserComment(w http.ResponseWriter, r *http.Request) {
	user, comment, ok := controller.extractAndValidateUserAndCommentFromRequest(w, r)
	if !ok {
		return
	}

	if err := controller.Store.DeleteComment(comment.Id); err != nil {
		if errors.Is(err, lang.ErrNotFound) {
			http.Redirect(w, r, "/users/"+strconv.Itoa(user.Id)+"/comments/", http.StatusFound)
			return
		}
		controller.sendInternalError(w, err)
		return
	}

	http.Redirect(w, r, "/users/"+strconv.Itoa(user.Id)+"/comments/", http.StatusFound)
}

func (controller *Controller) PostComment(w http.ResponseWriter, r *http.Request) {
	serviceKey := chi.URLParam(r, "serviceKey")
	postKey := chi.URLParam(r, "postKey")
	if serviceKey == "" || postKey == "" {
		controller.renderBadRequest(w)
		return
	}

	service, err := controller.Store.GetServiceForKey(serviceKey)
	if err != nil {
		controller.sendInternalError(w, err)
		return
	}

	user, err := controller.getUserFromSession(r)
	if err != nil {
		if errors.Is(err, lang.ErrNotFound) {
			controller.renderUnauthorized(w)
		} else {
			controller.sendInternalError(w, err)
		}
		return
	}

	if err := r.ParseForm(); err != nil {
		controller.renderBadRequest(w)
		return
	}

	commentIDString := r.FormValue("commentId")
	name := r.FormValue("name")
	website := r.FormValue("website")
	commentContent := r.FormValue("comment")
	parentURL := r.FormValue("parentUrl")

	if commentContent == "" {
		controller.renderBadRequest(w)
		return
	}

	if commentIDString != "" {
		commentID, err := strconv.Atoi(commentIDString)
		if err != nil {
			controller.renderNotFound(w)
			return
		}
		comment, err := controller.Store.GetComment(commentID)
		if err != nil {
			if errors.Is(err, lang.ErrNotFound) {
				controller.renderNotFound(w)
			} else {
				controller.sendInternalError(w, err)
			}
			return
		}
		if comment.UserId != user.Id || comment.Status == domain.CommentStatusApproved {
			controller.renderUnauthorized(w)
			return
		}
		if err := controller.Store.UpdateComment(comment.Id, comment.Status, commentContent, name, website, parentURL); err != nil {
			controller.sendInternalError(w, err)
			return
		}
		if err := controller.setFlash(w, r, "success", "Your comment has been updated"); err != nil {
			controller.sendInternalError(w, err)
			return
		}
		http.Redirect(w, r, "/services/"+serviceKey+"/posts/"+postKey+"/comments/", http.StatusFound)
		return
	}

	if _, err := controller.Store.CreateComment(domain.CommentStatusPendingApproval, service.Id, service.ServiceKey, user.Id, postKey, commentContent, name, website, parentURL); err != nil {
		controller.sendInternalError(w, err)
		return
	}

	if err := controller.setFlash(w, r, "success", "Your comment has been added"); err != nil {
		controller.sendInternalError(w, err)
		return
	}

	http.Redirect(w, r, "/services/"+serviceKey+"/posts/"+postKey+"/comments/", http.StatusFound)
}

func (controller *Controller) GetUserLoginForm(w http.ResponseWriter, r *http.Request) {
	userAuthenticated := false
	if _, err := controller.getUserFromSession(r); err == nil {
		userAuthenticated = true
	} else if !errors.Is(err, lang.ErrNotFound) {
		controller.sendInternalError(w, err)
		return
	}

	adminAuthenticated := false
	if _, err := controller.getAdminUserIdFromSession(r); err == nil {
		adminAuthenticated = true
	} else if !errors.Is(err, lang.ErrNotFound) {
		controller.sendInternalError(w, err)
		return
	}

	controller.renderTemplate(w, http.StatusOK, "userlogin", domain.LoginPageData{
		BasePage: domain.BasePage{
			Stylesheets: templateStylesheets,
			Scripts:     templateScripts,
		},
		IsAuthenticated: userAuthenticated || adminAuthenticated,
	})
}

func (controller *Controller) GetAdminHome(w http.ResponseWriter, r *http.Request) {
	http.Redirect(w, r, "/admin/comments", http.StatusFound)
}

func (controller *Controller) GetAdminDashboard(w http.ResponseWriter, r *http.Request) {
	adminUserID, err := controller.getAdminUserIdFromSession(r)
	if err != nil {
		if errors.Is(err, lang.ErrNotFound) {
			http.Redirect(w, r, "/login/", http.StatusUnauthorized)
		} else {
			controller.sendInternalError(w, err)
		}
		return
	}

	showStatusParam := r.URL.Query().Get("showStatus")
	statuses := []domain.CommentStatus{}
	if showStatusParam != "" {
		for status := range strings.SplitSeq(showStatusParam, ",") {
			parsedStatus, err := domain.ParseCommentStatus(status)
			if err != nil {
				controller.renderBadRequest(w)
				return
			}
			statuses = append(statuses, parsedStatus)
		}
	}

	comments, err := controller.Store.GetCommentsByStatus(statuses)
	if err != nil {
		controller.sendInternalError(w, err)
		return
	}

	successFlashes, errorFlashes, err := controller.getFlashes(w, r)
	if err != nil {
		controller.sendInternalError(w, err)
		return
	}

	controller.renderTemplate(w, http.StatusOK, "admin-dashboard", domain.AdminDashboardPage{
		BasePage: domain.BasePage{
			Stylesheets: templateStylesheets,
			Scripts:     templateScripts,
			Error:       errorFlashes,
			Success:     successFlashes,
		},
		AdminUser: domain.AdminUser{UserId: adminUserID},
		Comments:  comments,
		Statuses:  statuses,
	})
}

func (controller *Controller) GetServiceAdminDashboard(w http.ResponseWriter, r *http.Request) {
	adminUser, err := controller.getAdminUserFromSession(r)
	if err != nil {
		controller.sendInternalError(w, err)
		return
	}

	serviceKey := chi.URLParam(r, "servicekey")
	showStatusParam := r.URL.Query().Get("showStatus")
	statuses := []domain.CommentStatus{}
	if showStatusParam != "" {
		for status := range strings.SplitSeq(showStatusParam, ",") {
			parsedStatus, err := domain.ParseCommentStatus(status)
			if err != nil {
				controller.renderBadRequest(w)
				return
			}
			statuses = append(statuses, parsedStatus)
		}
	}

	comments, err := controller.Store.GetCommentsByServiceAndStatus(serviceKey, statuses)
	if err != nil {
		controller.sendInternalError(w, err)
		return
	}

	successFlashes, errorFlashes, err := controller.getFlashes(w, r)
	if err != nil {
		controller.sendInternalError(w, err)
		return
	}

	controller.renderTemplate(w, http.StatusOK, "admin-dashboard", domain.AdminDashboardPage{
		BasePage: domain.BasePage{
			Stylesheets: templateStylesheets,
			Scripts:     templateScripts,
			Error:       errorFlashes,
			Success:     successFlashes,
		},
		AdminUser: adminUser,
		Comments:  comments,
		Statuses:  statuses,
	})
}

func (controller *Controller) ServiceAdminApproveComment(w http.ResponseWriter, r *http.Request) {
	if _, err := controller.getAdminUserFromSession(r); err != nil {
		controller.sendInternalError(w, err)
		return
	}

	serviceKey := chi.URLParam(r, "servicekey")
	comment, err := controller.requireCommentAndRetrieve(r)
	if err != nil {
		controller.handleCommonErrors(w, err)
		return
	}

	if comment.ServiceKey != serviceKey {
		controller.renderForbidden(w)
		return
	}

	if err := controller.Store.UpdateComment(comment.Id, domain.CommentStatusApproved, comment.Comment, comment.Name, comment.Website, comment.ParentUrl); err != nil {
		controller.sendInternalError(w, err)
		return
	}

	http.Redirect(w, r, "/admin/"+serviceKey+"/comments", http.StatusFound)
}

func (controller *Controller) ServiceAdminDeleteComment(w http.ResponseWriter, r *http.Request) {
	if _, err := controller.getAdminUserFromSession(r); err != nil {
		controller.sendInternalError(w, err)
		return
	}

	serviceKey := chi.URLParam(r, "servicekey")
	comment, err := controller.requireCommentAndRetrieve(r)
	if err != nil {
		controller.handleCommonErrors(w, err)
		return
	}

	if comment.ServiceKey != serviceKey {
		controller.renderForbidden(w)
		return
	}

	if err := controller.Store.DeleteComment(comment.Id); err != nil {
		controller.sendInternalError(w, err)
		return
	}

	http.Redirect(w, r, "/admin/"+serviceKey+"/comments", http.StatusFound)
}

func (controller *Controller) GetSuperAdminServices(w http.ResponseWriter, r *http.Request) {
	adminUser, err := controller.getAdminUserFromSession(r)
	if err != nil {
		controller.sendInternalError(w, err)
		return
	}

	services, err := controller.Store.GetAllServices()
	if err != nil {
		controller.sendInternalError(w, err)
		return
	}

	successFlashes, errorFlashes, err := controller.getFlashes(w, r)
	if err != nil {
		controller.sendInternalError(w, err)
		return
	}

	controller.renderTemplate(w, http.StatusOK, "superadmin-services", struct {
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
	})
}

func (controller *Controller) GetSuperAdminDashboard(w http.ResponseWriter, r *http.Request) {
	adminUser, err := controller.getAdminUserFromSession(r)
	if err != nil {
		controller.sendInternalError(w, err)
		return
	}

	showStatusParam := r.URL.Query().Get("showStatus")
	statuses := []domain.CommentStatus{}
	if showStatusParam != "" {
		for status := range strings.SplitSeq(showStatusParam, ",") {
			parsedStatus, err := domain.ParseCommentStatus(status)
			if err != nil {
				controller.renderBadRequest(w)
				return
			}
			statuses = append(statuses, parsedStatus)
		}
	}

	comments, err := controller.Store.GetCommentsByStatus(statuses)
	if err != nil {
		controller.sendInternalError(w, err)
		return
	}

	successFlashes, errorFlashes, err := controller.getFlashes(w, r)
	if err != nil {
		controller.sendInternalError(w, err)
		return
	}

	controller.renderTemplate(w, http.StatusOK, "admin-dashboard", domain.AdminDashboardPage{
		BasePage: domain.BasePage{
			Stylesheets: templateStylesheets,
			Scripts:     templateScripts,
			Error:       errorFlashes,
			Success:     successFlashes,
		},
		AdminUser: adminUser,
		Comments:  comments,
		Statuses:  statuses,
	})
}

func (controller *Controller) GetDemo(w http.ResponseWriter, r *http.Request) {
	user, err := controller.getUserFromSession(r)
	if err != nil && !errors.Is(err, lang.ErrNotFound) {
		controller.sendInternalError(w, err)
		return
	}
	controller.renderTemplate(w, http.StatusOK, "demo", domain.DemoPage{
		BasePage: domain.BasePage{
			Stylesheets: templateStylesheets,
			Scripts:     templateScripts,
		},
		User: user,
	})
}

func (controller *Controller) requireCommentAndRetrieve(r *http.Request) (domain.Comment, error) {
	commentIDString := chi.URLParam(r, "commentId")
	if commentIDString == "" {
		return domain.Comment{}, ErrIllegalArgument
	}
	commentID, err := strconv.Atoi(commentIDString)
	if err != nil {
		return domain.Comment{}, ErrIllegalArgument
	}
	return controller.Store.GetComment(commentID)
}

func (controller *Controller) extractAndValidateUserAndCommentFromRequest(w http.ResponseWriter, r *http.Request) (domain.User, domain.Comment, bool) {
	userIDString := chi.URLParam(r, "userId")
	if userIDString == "" {
		controller.renderBadRequest(w)
		return domain.User{}, domain.Comment{}, false
	}

	userID, err := strconv.Atoi(userIDString)
	if err != nil {
		controller.renderBadRequest(w)
		return domain.User{}, domain.Comment{}, false
	}

	user, err := controller.getUserFromSession(r)
	if err != nil {
		handleAuthenticationError(controller, w, err)
		return domain.User{}, domain.Comment{}, false
	}

	if user.Id != userID {
		controller.renderUnauthorized(w)
		return domain.User{}, domain.Comment{}, false
	}

	comment, err := controller.requireCommentAndRetrieve(r)
	if err != nil {
		controller.handleCommonErrors(w, err)
		return domain.User{}, domain.Comment{}, false
	}

	if comment.UserId != user.Id {
		controller.renderUnauthorized(w)
		return domain.User{}, domain.Comment{}, false
	}

	return user, comment, true
}
