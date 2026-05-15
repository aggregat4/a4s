(function () {
  function requestCommentLogin(element) {
    if (!element) {
      return true;
    }

    const embedLoginPath = element.getAttribute('data-embed-login-path');
    const embedderOrigin = element.getAttribute('data-embedder-origin');

    if (window.self === window.top || !embedLoginPath || !embedderOrigin) {
      return true;
    }

    window.parent.postMessage({
      type: 'comment-login-request',
      loginPath: embedLoginPath,
    }, embedderOrigin);
    return false;
  }

  window.requestCommentLogin = requestCommentLogin;
})();
