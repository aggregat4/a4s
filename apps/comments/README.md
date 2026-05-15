# Website Comment Service

This is a go service that offers embeddable commenting functionality for
websites. One of the target uses is to be able to embed this into an otherwise
statically generated website like a blog.

You can configure a website that you want to add comments to. This service can
render those comments in an iframe under its posts.

The service allows users to submit comments and uses OpenID Connect for authentication.

Comments need to be authenticated to be considered for approval as this service
is built to be operated in a GDPR-compliant fashion.

Users can see, export, edit and delete their comments.

Admins for a particular website can screen, approve or deny comments. Only
authenticated comments are considered.

## Embedding the Comments Page

To embed comments on your website, you'll need to:

1. Register your website with the comment service to get a service ID
2. Add an iframe element to your page where you want the comments to appear
3. Add the required message listener for resizing and top-level authentication handoff

For the complete embedder contract, including authentication behavior and the
required message handling, see [`docs/embedding.md`](docs/embedding.md).

### Basic Implementation

Add an iframe to your page using the following format:

```html
<iframe
  src="https://your-comment-service.com/services/{serviceId}/posts/{postKey}/comments/"
  width="100%"
  style="border: none;"
  id="comments-iframe"
></iframe>
```

Replace:

- `your-comment-service.com` with your actual comment service domain
- `{serviceId}` with your registered service ID
- `{postKey}` with a unique identifier for the current page/post

### Automatic Height Adjustment

To ensure the iframe resizes automatically to fit its content without scrollbars, add this JavaScript to your page:

```javascript
window.addEventListener('message', function(e) {
    // Verify the message origin for security
    if (e.origin !== 'https://your-comment-service.com') return;
    // Check if it's a height update message
    if (e.data && e.data.type === 'comment-height') {
        const iframe = document.querySelector('.comment-frame');
        if (iframe) {
            iframe.style.height = e.data.height + 'px';
        }
    }
    if (e.data && e.data.type === 'comment-login-request') {
        const loginUrl = new URL(e.data.loginPath, e.origin);
        loginUrl.searchParams.set('returnTo', window.location.href);
        window.location.href = loginUrl.toString();
    }
});
```

The comment service will automatically send height update messages whenever the
content size changes. When a user chooses to log in from the embedded comments
UI, the iframe asks the host page to begin a top-level login flow so browser
privacy protections do not strand authentication inside an embedded context.

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

## Running the Demo Locally

A self-contained demo is available at `/demo` once the server is running.

The demo bundles a **mock OIDC provider** so you can test the full authentication flow without configuring an external identity provider.

### Start the demo server

```bash
./scripts/runexampleserver.sh
```

Then open `http://localhost:8080/demo` in your browser. The demo page shows a sample article with an embedded comments iframe. Clicking **Login** will auto-authenticate you against the embedded mock OIDC provider, giving you both commenter and admin rights.

### Demo URLs

| Page | URL |
|---|---|
| Demo article | `http://localhost:8080/demo` |
| Comments (iframe) | `http://localhost:8080/services/demoservice/posts/demopost/comments/` |
| Admin dashboard | `http://localhost:8080/admin` |
| Superadmin services | `http://localhost:8080/superadmin/services` |

The demo server creates an in-memory SQLite database and seeds a demo service automatically. Its data is discarded when the process stops, so each restart begins from a clean demo state. Press `Ctrl+C` to stop.

### Production setup

For production deployment you need a real OIDC provider and a proper `commentservice.json` configuration file. See `cmd/runserver/main.go` for the production server entry point.

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

Users (commenters) also authenticate via OIDC but require no special rights.

### Authenticated Commenter Login Flow

The add/edit comment form is only available to authenticated users. When an
unauthenticated visitor opens the form inside an embed:

- The iframe renders a `Login to Comment` control.
- Clicking it sends a `comment-login-request` message to the embedding page.
- The embedding page starts a top-level login handoff by navigating the full
  browser window to the service-scoped `/login/services/{serviceKey}/embed`
  route with its own current page URL as `returnTo`.
- The comment service performs OIDC in the top-level browsing context and then
  redirects back to the registered embedding origin.
- When the host page reloads, the iframe reloads with the authenticated session
  available.

The full embedder contract is documented in [`docs/embedding.md`](docs/embedding.md).

Once authenticated, the form re-renders with the comment inputs. Subsequent
comment submissions and edits then proceed through the standard approval
workflow.
