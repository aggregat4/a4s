# TODO

2. Figure out the routing: comments is own resource, from /admin have a link there or automatically redirect for now?
3. Remove pico.css from the remaining form based pages and restyle them (maybe there is a nice set of form styles that I can use?)
4. What should be in a `<header>` element and what not? Should the title of the page and any specific actions or links be in the header or not? Tending towards putting them in main and only reserving header for sitewide things?
5. Make the server cookie settings configurable
6. Figure out the navigation story: there are a lot of pages and we have embeded
   pages in other sites and we have the management ui somewhere for users and
   for admins. How is that accesible? How do you get back to some other ui?
7. Look for todos about toasts to inform users about error states and success states
8. Implement actual mail sending integration
9. Consider storing comments in localstorage as well: this may let us allow people recover text that they have submitted with the wrong email address? On the other hand privacy? Problem on a public computer? It may also serve as a backup generally?
10. Set caching headers on responses where it makes sense
11. Redirect from collection pages without a trailing slash to the one with the slash
