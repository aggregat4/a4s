
# TODO

1. Introduced the concept of the admin user that is authenticated through OIDC. This user does not have the same form as a normal user at all. I was originally planning to use the same session cookie for this as for the normal user, but I'm not sure anymore. See `AuthenticateUser` and `createSessionCookie`. How do I model the two user types and their persistent session?
1. What should be in a `<header>` element and what not? Should the title of the page and any specific actions or links be in the header or not? Tending towards putting them in main and only reserving header for sitewide things?
2. Make the server cookie settings configurable
2. Figure out the navigation story: there are a lot of pages and we have embeded
   pages in other sites and we have the management ui somewhere for users and
   for admins. How is that accesible? How do you get back to some other ui? 
3. Look for todos about toasts to inform users about error states and success states
4. Implement actual mail sending integration
5. Consider storing comments in localstorage as well: this may let us allow people recover text that they have submitted with the wrong email address? On the other hand privacy? Problem on a public computer? It may also serve as a backup generally?
6. Set caching headers on responses where it makes sense
7. Redirect from collection pages without a trailing slash to the one with the slash
