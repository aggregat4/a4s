# Website Comment Service

This is a go service that offers embeddable commenting functionality for
websites. One of the target uses is to be able to embed this into an otherwise
statically generated website like a blog.

You can configure a website that you want to add comments to. This service can
render those comments in an iframe under its posts.

The service allows users to submit comments and uses email based authentication
to validate the email address.

Comments need to be authenticated to be considered for approval as this service
is built to be operated in a GDPR-compliant fashion.

Users can see, export, edit and delete their comments.

Admins for a particular website can screen, approve or deny comments. Only
authenticated comments are considered.

## Privacy Laws, GDPR and this Project

It is impossible to satisfy privacy law requirements on a technical level alone.

This implementation aims to provide technical means that can enable a privacy
preserving and privacy protecting comment service, but the ultimate compliance
with one or more privacy laws is an organizational effort that is out of scope
of this project.

Privacy law is relevant for comments, because they are inherently personal data
as we capture the email address, optionally a name and website of the user and
the comment content itself and then publicly display that on various websites.

The user needs to have a set of tools to see, export, change and delete their
own personal data.

The user needs to be informed about the way that their data is used and shared
with third parties through a privacy policy.

An administrator needs the ability to screen and remove problematic content.

Finally, it must be possible to set age requirements on comment posting to avoid
running into consent issues when it comes to gathering personal data on minors.

## Security

### Encryption

All personal data (email addresses, optional name, optional website and comment
contents) is _encrypted at rest_.

The service should be operated over TLS through the use of an appropriate proxy
server.

### Authentication

Admins authenticate via OpenID Connect (OIDC) and require a service specific
admin claim.

Super admins authenticate via OIDC and require a "superadmin" claim to manage
the site configurations.

User authentication is based on email:

- Users are sent an email with a time-limited high entropy authentication token
- Upon token validation a time-limited cookie is set with the user's information

## TODO

1. Write tests for comment deletion and authentication
2. Make the server cookie settings configurable
3. Figure out the navigation story: there are a lot of pages and we have embeded
   pages in other sites and we have the management ui somewhere for users and
   for admins. How is that accesible? How do you get back to some other ui? 
4. Look for todos about toasts to inform users about error states and success states