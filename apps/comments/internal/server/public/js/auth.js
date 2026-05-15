(function () {
  const AUTH_CONTEXT_KEY = '__commentServiceAuthContext';

  function setStatus(message) {
    const ctx = window[AUTH_CONTEXT_KEY];
    if (!ctx || !ctx.statusEl) {
      return;
    }
    ctx.statusEl.textContent = message;
    ctx.statusEl.hidden = !message;
  }

  function showBlocked() {
    const ctx = window[AUTH_CONTEXT_KEY];
    if (!ctx) {
      return;
    }
    if (ctx.blockedEl) {
      ctx.blockedEl.hidden = false;
    }
    if (ctx.statusEl) {
      ctx.statusEl.hidden = true;
    }
  }

  function openAuthPopup(button) {
    if (!button) {
      return true;
    }

    const loginUrl = button.getAttribute('data-login-url');
    const origin = button.getAttribute('data-login-origin') || window.location.origin;
    const fullPageUrl = button.getAttribute('data-login-fullpage') || '/login';
    const statusEl = document.querySelector('[data-popup-status]');
    const blockedEl = document.querySelector('[data-popup-blocked]');

    if (blockedEl) {
      blockedEl.hidden = true;
    }

    const width = 520;
    const height = 680;
    const left = window.screenX + Math.max(0, (window.outerWidth - width) / 2);
    const top = window.screenY + Math.max(0, (window.outerHeight - height) / 2);
    const features = [
      `width=${width}`,
      `height=${height}`,
      `left=${Math.round(left)}`,
      `top=${Math.round(top)}`,
      'resizable=yes',
      'scrollbars=yes',
    ].join(',');

    const popup = window.open(loginUrl, 'commentservice-login', features);

    window[AUTH_CONTEXT_KEY] = {
      origin,
      statusEl,
      blockedEl,
      fullPageUrl,
    };

    if (!popup || popup.closed) {
      showBlocked();
      return false;
    }

    if (statusEl) {
      statusEl.textContent = 'Login window opened. Complete authentication and we will refresh this page.';
      statusEl.hidden = false;
    }

    try {
      popup.focus();
    } catch (_) {
      // Some browsers throw if focus fails; ignore.
    }

    return false;
  }

  function handleAuthMessage(event) {
    const expectedOrigin = window.location.origin;
    if (event.origin !== expectedOrigin) {
      return;
    }
    const data = event.data;
    if (!data || typeof data !== 'object') {
      return;
    }

    if (data.type === 'auth-success') {
      // Mark that we are reloading after a successful popup auth.
      // If the cookie was not persisted (e.g. Firefox partitioning),
      // the layout script will detect this and fall back to a
      // full-page OIDC flow to establish the session in the main tab.
      sessionStorage.setItem('commentServiceAuthSuccess', '1');
      window.location.reload();
      return;
    } else if (data.type === 'auth-error') {
      const message = data.message || 'We could not complete authentication. Please try again or use the full-page login link.';
      setStatus(message);
      const ctx = window[AUTH_CONTEXT_KEY];
      if (ctx && ctx.blockedEl) {
        ctx.blockedEl.hidden = false;
      }
    }
  }

  window.openAuthPopup = openAuthPopup;
  window.addEventListener('message', handleAuthMessage);
})();
