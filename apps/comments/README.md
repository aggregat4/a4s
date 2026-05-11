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
3. Implement the iframe resizing listener for a seamless experience

### Basic Implementation

Add an iframe to your page using the following format:

```html
<iframe
  src="https://your-comment-service.com/servicces/{serviceId}/posts/{postKey}/comments"
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
});
```

The comment service will automatically send height update messages whenever the content size changes, ensuring a seamless integration without iframe scrollbars.

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

### Prerequisites

You need a valid `commentservice.json` configuration file with at least these fields:

```json
{
  "port": 8080,
  "database_filename": "commentservice",
  "base_url": "http://localhost:8080",
  "oidc_idp_server": "https://your-idp.example.com",
  "oidc_client_id": "your-client-id",
  "oidc_client_secret": "your-client-secret",
  "oidc_redirect_uri": "http://localhost:8080/oidccallback",
  "encryption_key": "your-32-byte-hex-key",
  "session_cookie_secret_key": "your-session-secret",
  "session_cookie_secure_flag": false
}
```

Generate an encryption key with:

```bash
go run cmd/createencryptionkey/main.go
```

### Start the server and seed demo data

```bash
# 1. Create a demo service in the database
./scripts/runcreateexampleservice.sh

# 2. Start the server
./scripts/runexampleserver.sh
```

Then open `http://localhost:8080/demo` in your browser. The demo page shows a sample article with an embedded comments iframe so you can test the full flow end-to-end.

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

The add/edit comment form is only available to authenticated users. When an unauthenticated visitor opens the form:

- The page renders a login prompt with a `Login to Comment` button and guidance about popup blockers. The prompt contains both the popup login URL (`/login?popup=1`) and a full-page fallback (`/login`).
- Clicking the button attempts to open the `/login?popup=1` route in a centered popup window. While the popup is open, an inline status message reminds the visitor to finish authentication.
- The popup serves the same OIDC-backed login page, but in popup mode it posts a message back to the opener (`postMessage({ type: 'auth-success' }, origin)`) once the OIDC callback creates the session. After the message is delivered the popup closes itself.
- The opener listens for that success message and reloads the add/edit form so the freshly authenticated state is visible without manual refresh.

Failure and fallback handling:

- If the popup cannot be opened (blocked by the browser), the UI exposes an inline alert with a direct link to the full-page login flow so the visitor can continue.
- If the OIDC flow encounters an error, the popup can stay open and the inline status message encourages the visitor to retry or fall back to the full-page login.
- All postMessage exchanges are origin-scoped using the configured service origin, so unexpected origins are ignored.

Once authenticated, the form re-renders with the comment inputs. Subsequent comment submissions and edits then proceed through the standard approval workflow.
