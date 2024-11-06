# TODO

1. Style the admin dashboard
   1. Should I even be using pico CSS? It's kind of annoying as seen in admin dashboard... maybe just have my own approach?
2. What should be in a `<header>` element and what not? Should the title of the page and any specific actions or links be in the header or not? Tending towards putting them in main and only reserving header for sitewide things?
3. Make the server cookie settings configurable
4. Figure out the navigation story: there are a lot of pages and we have embeded
   pages in other sites and we have the management ui somewhere for users and
   for admins. How is that accesible? How do you get back to some other ui?
5. Look for todos about toasts to inform users about error states and success states
6. Implement actual mail sending integration
7. Consider storing comments in localstorage as well: this may let us allow people recover text that they have submitted with the wrong email address? On the other hand privacy? Problem on a public computer? It may also serve as a backup generally?
8. Set caching headers on responses where it makes sense
9. Redirect from collection pages without a trailing slash to the one with the slash
