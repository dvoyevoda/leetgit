(() => {
  if (window !== window.top) return;

  let lastPath;

  function slugFromPath(path) {
    return /^\/problems\/([a-z0-9][a-z0-9-]{0,149})(?:\/|$)/.exec(path)?.[1] ?? null;
  }

  function report(force = false) {
    if (document.prerendering) return;
    const path = window.location.pathname;
    if (!force && path === lastPath) return;
    lastPath = path;
    const slug = slugFromPath(path);

    try {
      void chrome.runtime.sendMessage({ type: "leetcode.context", slug }).catch(() => {});
    } catch {
      // An already-open page needs a refresh after reloading the extension.
    }
  }

  window.navigation?.addEventListener("currententrychange", () => report());
  window.addEventListener("popstate", () => report());
  window.addEventListener("pageshow", () => report(true));
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || document.prerendering) return;
    if (message?.type === "relay.refreshContext") report(true);
    if (message?.type === "relay.readContext") sendResponse({ slug: slugFromPath(window.location.pathname) });
  });
  if (document.prerendering) {
    document.addEventListener("prerenderingchange", () => report(), { once: true });
  }
  report();
})();
