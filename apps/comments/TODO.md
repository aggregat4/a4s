# TODO

* Testing improvements:
  * build helpers that mint session cookies / OIDC stubs so we can assert authenticated success paths end-to-end
  * add positive workflow tests that cover comment creation, admin approvals, and super-admin dashboards using those helpers
  * track full coverage with `go test -coverpkg=./... ./...` (or equivalent) once happy-path tests exist, so cross-package calls remain visible

* CONTINUE here: Sketched out the login flow for unauthenticated commenters:
  * user clicks "add comment"
  * when unauthenticated they land on the addeditcomment page in the state unauthenticated and get the option to log in
  * clicking the log in triggers a popup showing a popuplogin page that is OIDC protected and triggers the OIDC flow
  * on returning from the flow, the authenticated version of that page is displayed and it uses javascript to autoclose the popup and send a postmessage to the opener
  * the opener is the addeditcomment page and it will reload on receiving the postmessage
  * TODO: implement this and consider the failure cases

* Show a logged in user's own comments when they are not yet approved but with some marker: this confirms that the comment arrived

* everything is now authenticated aside from the infrastructure endpoints and the comment list for a post itself. Figure out what the login flow looks like for unauthenticated users and what sort of "add comment" link I add to the comment page and where I add the admin links ...

* align the user comment styling with the admin dashboard styling

* retain some minimal formatting from comments. At least paragraphs.

* when logged in as a user and seeing your comments on a post and being able to modify them, we should highlight the comment somehow

* after confirming the comment and then rendering the original post, there is an error in the console

* need a way for service owners to specify custom css for the comments page

* consider real caching of the postcomments page: we need to make sure that the comments are always up to date, but we also need to make sure that the page is not too slow to load

* Set caching headers on responses where it makes sense

* Redirect from collection pages without a trailing slash to the one with the slash
