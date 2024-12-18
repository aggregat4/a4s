# TODO

* The post comments page persists the success flash message ( /services/foobar/posts/blub/comments/ )
* Add a link to the post that a comment is made on to the admin dashboard (or a way to preview it?)
* add UserId to PostCommentsPage , we depend on it in the template (do it like in usercomments)
* Look for todos about toasts to inform users about error states and success states
* Implement actual mail sending integration
* Consider storing comments in localstorage as well: this may let us allow people recover text that they have submitted with the wrong email address? On the other hand privacy? Problem on a public computer? It may also serve as a backup generally?
* Set caching headers on responses where it makes sense
* Redirect from collection pages without a trailing slash to the one with the slash
