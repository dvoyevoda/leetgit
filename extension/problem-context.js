(() => {
  if (window !== window.top) return;

  let lastSlug;

  function report(force = false) {
    if (document.prerendering) return;
    const slug = /^\/problems\/([a-z0-9][a-z0-9-]{0,149})(?:\/|$)/.exec(window.location.pathname)?.[1] ?? null;
    if (!force && slug === lastSlug) return;
    lastSlug = slug;

    try {
      void chrome.runtime.sendMessage({ type: "leetcode.context", slug }).catch(() => {});
    } catch {
      // An already-open page needs a refresh after reloading the extension.
    }
  }

  window.navigation?.addEventListener("currententrychange", () => report());
  window.addEventListener("popstate", () => report());
  window.addEventListener("pageshow", (event) => report(event.persisted));
  if (document.prerendering) {
    document.addEventListener("prerenderingchange", () => report(), { once: true });
  }
  report();
})();
