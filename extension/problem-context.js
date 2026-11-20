(() => {
  if (window !== window.top) return;

  let lastPath;

  function report(force = false) {
    if (document.prerendering) return;
    const path = window.location.pathname;
    if (!force && path === lastPath) return;
    lastPath = path;
    const slug = /^\/problems\/([a-z0-9][a-z0-9-]{0,149})(?:\/|$)/.exec(path)?.[1] ?? null;

    try {
      void chrome.runtime.sendMessage({ type: "leetcode.context", slug }).catch(() => {});
    } catch {
      // An already-open page needs a refresh after reloading the extension.
    }
  }

  window.navigation?.addEventListener("currententrychange", () => report());
  window.addEventListener("popstate", () => report());
  window.addEventListener("pageshow", () => report(true));
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.id === chrome.runtime.id && message?.type === "relay.refreshContext") report(true);
  });
  if (document.prerendering) {
    document.addEventListener("prerenderingchange", () => report(), { once: true });
  }
  report();
})();
