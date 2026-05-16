package domain

// BasePage contains fields common to all pages
type BasePage struct {
	Stylesheets       []string
	Scripts           []string
	Error             []string
	Success           []string
	Auth              AuthContext
	CurrentPath       string
	EmbedderOrigin    string
	EmbedLoginPath    string
	IsEmbeddedPage    bool
	PrivacyPolicyURL  string
	MinimumCommentAge int
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

type UserLoginPage struct {
	BasePage
}

type PrivacyPolicyPage struct {
	BasePage
}

type DemoPage struct {
	BasePage
	User    User
	BaseURL string
}

type LoginPageData struct {
	BasePage
	IsAuthenticated bool
}
