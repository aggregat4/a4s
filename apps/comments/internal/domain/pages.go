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

type PostCommentsPage struct {
	BasePage
	User       User
	ServiceKey string
	PostKey    string
	Comments   []Comment
}

type UserCommentsPage struct {
	BasePage
	User     User
	Comments []Comment
}

type UserAuthenticationPage struct {
	BasePage
	EmailAddress string
}

type AdminDashboardPage struct {
	BasePage
	AdminUser AdminUser
	Comments  []Comment
	Statuses  []CommentStatus
}

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

type DemoPage struct {
	BasePage
	User User
}
