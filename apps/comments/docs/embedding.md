# Embedding the Comment Service

This document describes the integration contract for sites that embed the
comment service in an iframe.

## Why login uses a top-level redirect

The comment UI is embedded as third-party content on the host page. Modern
browsers increasingly partition or restrict third-party storage, which makes
authentication flows that run inside the iframe or a popup less reliable.

For that reason, embedded login deliberately uses a **top-level browser
navigation**:

1. The user clicks a login control inside the comments iframe.
2. The iframe sends a `comment-login-request` message to the host page.
3. The host page navigates the full browser window to the comment service's
   service-scoped login handoff URL.
4. The comment service performs the normal OIDC login flow in the top-level
   browsing context.
5. After successful authentication, the comment service redirects the browser
   back to the host page URL supplied by the embedder.
6. The host page reloads normally, and the comments iframe loads with the
   authenticated session available.

This is less seamless than a popup, but it is simpler and more robust across
browser privacy models.

## Required host-page integration

The embedding page must:

1. Embed the comments iframe.
2. Register the host site's origin with the comment service.
3. Listen for messages from the comment-service origin.
4. Handle both resize messages and login requests.

Example:

```html
<iframe
  class="comment-frame"
  src="https://comments.example.com/services/blog/posts/post-123/comments/"
  title="Comments"
  scrolling="no"
  style="width: 100%; border: none; overflow: hidden;"
></iframe>

<script>
  const commentServiceOrigin = 'https://comments.example.com';
  const iframe = document.querySelector('.comment-frame');

  window.addEventListener('message', (event) => {
    if (event.origin !== commentServiceOrigin) {
      return;
    }

    if (event.data?.type === 'comment-height') {
      iframe.style.height = `${event.data.height}px`;
      return;
    }

    if (event.data?.type === 'comment-login-request') {
      const loginUrl = new URL(event.data.loginPath, commentServiceOrigin);
      loginUrl.searchParams.set('returnTo', window.location.href);
      window.location.href = loginUrl.toString();
    }
  });
</script>
```

## Security requirements

- Always verify `event.origin` before acting on a message.
- Only accept the documented message types.
- The `returnTo` URL must belong to the registered host-site origin. The
  comment service validates this server-side before redirecting back.
- Register the exact embedding origin with the comment service. The service
  uses it both for iframe embedding policy and for validating login return
  destinations.

## UX consequences for embedders

Because login is a full-page navigation:

- unsaved in-memory page state is lost unless the host page preserves it;
- the browser returns to the host page after login and reloads the iframe;
- client-side routed sites should ensure `window.location.href` contains the
  route users should return to;
- hosts that care about scroll restoration should preserve or restore scroll
  position around the login round trip.

## Messages sent by the iframe

### `comment-height`

Sent when the iframe content height changes.

```json
{
  "type": "comment-height",
  "height": 420
}
```

### `comment-login-request`

Sent when an unauthenticated user asks to log in from embedded comments.

```json
{
  "type": "comment-login-request",
  "loginPath": "/login/services/blog/embed"
}
```

The host page is responsible for converting `loginPath` into a full URL and
adding `returnTo=window.location.href` before navigating the top-level window.
