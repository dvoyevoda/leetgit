(() => {
  const ORIGIN = "https://leetcode.com";

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== ORIGIN) return;
    if (event.data?.type !== "leetrelay:accepted-submission") return;

    const submission = event.data.submission;
    if (!submission || typeof submission !== "object") return;
    const { id, slug, language, code, acceptedAt } = submission;
    if (typeof id !== "string" || !/^[1-9]\d{0,19}$/.test(id)) return;
    if (typeof slug !== "string" || !/^[a-z0-9][a-z0-9-]{0,149}$/.test(slug)) return;
    if (typeof language !== "string" || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(language)) return;
    if (typeof code !== "string" || !code.length || code.length > 256 * 1024) return;
    if (typeof acceptedAt !== "string" || !Number.isFinite(Date.parse(acceptedAt))) return;

    void chrome.runtime.sendMessage({
      type: "leetcode.accepted",
      submission: {
        id,
        slug,
        language,
        code,
        url: `${ORIGIN}/problems/${slug}/submissions/${id}/`,
        acceptedAt: new Date(acceptedAt).toISOString(),
      },
    }).catch(() => {
      // Tabs opened before an extension reload need a refresh to reconnect.
    });
  });
})();
