# TODO

* need a way for service owners to specify custom css for the comments page
* consider real caching of the postcomments page: we need to make sure that the comments are always up to date, but we also need to make sure that the page is not too slow to load
* Look for todos about toasts to inform users about error states and success states
* Implement actual mail sending integration
* Consider storing comments in localstorage as well: this may let us allow people recover text that they have submitted with the wrong email address? On the other hand privacy? Problem on a public computer? It may also serve as a backup generally?
* Set caching headers on responses where it makes sense
* Redirect from collection pages without a trailing slash to the one with the slash
 