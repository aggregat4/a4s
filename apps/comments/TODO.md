# TODO

* fix user dashboard: The layout of the user dashboard has no padding (as the userauthentication page), there is a weird sentence in the comment list and there is not link to the original post
* after confirming the comment and then rendering the original post, there is an error in the console
* after confirming the comment and then rendering the original post, there is an error in the console: `
* need a way for service owners to specify custom css for the comments page
* consider real caching of the postcomments page: we need to make sure that the comments are always up to date, but we also need to make sure that the page is not too slow to load
* Consider storing comments in localstorage as well: this may let us allow people recover text that they have submitted with the wrong email address? On the other hand privacy? Problem on a public computer? It may also serve as a backup generally?
* Set caching headers on responses where it makes sense
* Redirect from collection pages without a trailing slash to the one with the slash
* retain some minimal formatting from comments. At least paragraphs.
* when logged in as a user and seeing your comments on a post and being able to modify them, we should highlight the comment somehow