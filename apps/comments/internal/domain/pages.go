package domain

// BasePage contains fields common to all pages
type BasePage struct {
	Stylesheets []string
	Scripts     []string
	Error       []string
	Success     []string
}

type ErrorPage struct {
	BasePage
}

// PostCommentsPage represents the data needed for the post comments page
type PostCommentsPage struct {
	BasePage
	ServiceKey string
	PostKey    string
	Comments   []Comment
}

// UserCommentsPage represents the data needed for the user comments page
type UserCommentsPage struct {
	BasePage
	User     User
	Comments []Comment
}

// UserAuthenticationPage represents the data needed for the user authentication page
type UserAuthenticationPage struct {
	BasePage
	EmailAddress string
}

// AdminDashboardPage represents the data needed for the admin dashboard
type AdminDashboardPage struct {
	BasePage
	AdminUser AdminUser
	Comments  []Comment
	Statuses  []CommentStatus
}

// AddOrEditCommentPage represents the data needed for the add/edit comment page
type AddOrEditCommentPage struct {
	BasePage
	ServiceKey   string
	PostKey      string
	UserFound    bool
	User         User
	CommentFound bool
	Comment      Comment
}

type AdminLoginPage struct {
	BasePage
}
