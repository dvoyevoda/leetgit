(() => {
  const ORIGIN = "https://leetcode.com";
  const MAX_DESCRIPTION_BYTES = 120 * 1024;
  const MAX_MARKDOWN_BYTES = 96 * 1024;

  function text(value, max) {
    if (typeof value !== "string" || value.length > max) return undefined;
    return value.replace(/\s+/g, " ").trim() || undefined;
  }

  function assignDefined(target, fields) {
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) target[key] = value;
    }
  }

  function renderedProblem(slug, paidOnly) {
    const prefix = `/problems/${slug}`;
    const path = window.location.pathname;
    if (path !== prefix && !path?.startsWith(`${prefix}/`)) return {};

    const links = document.querySelectorAll(`a[href^="${prefix}"], a[href^="${ORIGIN}${prefix}"]`);
    const labels = [];
    for (const link of links) {
      const url = new URL(link.href, ORIGIN);
      const target = url.pathname.replace(/\/$/, "");
      if (url.origin === ORIGIN && (target === prefix || target === `${prefix}/description`)) {
        labels.push(link.textContent);
      }
    }
    const heading = document.querySelector('[data-cy="question-title"], [data-testid="question-title"], [data-e2e-locator="question-title"]')?.textContent;
    const metadataTitle = document.querySelector('meta[property="og:title"]')?.content ?? document.title;
    const pageTitle = /^(.+)\s+[-–]\s+LeetCode$/i.exec(metadataTitle ?? "")?.[1];
    const displayTitle = [...labels, heading, pageTitle]
      .map(value => /^([\p{L}\p{N}][\p{L}\p{N}. -]{0,31}?)\.\s+(.+)$/u.exec(text(value, 240) ?? ""))
      .find(match => /\d/.test(match?.[1] ?? ""));
    const title = displayTitle?.[2] ?? text(heading, 200) ?? pageTitle;
    const difficulty = document.querySelector('[data-difficulty], [class*="text-difficulty-"]')?.textContent;
    const problem = { title, frontendId: displayTitle?.[1], difficulty };

    if (paidOnly === false) {
      const statement = document.querySelector('[data-track-load="description_content"], [data-testid="question-content"]');
      if (statement?.checkVisibility?.({ opacityProperty: true, visibilityProperty: true })) {
        problem.descriptionHtml = statement.innerHTML;
      }
    }
    return problem;
  }

  function captureProblem(slug, observed) {
    const problem = {};
    const paidOnly = typeof observed?.paidOnly === "boolean" ? observed.paidOnly : undefined;
    let fallback = {};
    try {
      fallback = renderedProblem(slug, paidOnly);
    } catch {
      // Page markup is optional when LeetCode changes the problem layout.
    }
    const difficulty = text(observed?.difficulty, 10) ?? text(fallback.difficulty, 10);
    assignDefined(problem, {
      title: text(observed?.title, 200) ?? text(fallback.title, 200),
      frontendId: text(observed?.frontendId, 32) ?? text(fallback.frontendId, 32),
      difficulty: ["Easy", "Medium", "Hard"].find(value => value.toLowerCase() === difficulty?.toLowerCase()),
      paidOnly,
    });

    if (Array.isArray(observed?.topics)) {
      const topics = observed.topics.slice(0, 24).map(topic => text(topic, 80)).filter(Boolean);
      if (topics.length) problem.topics = [...new Set(topics)];
    }
    if (paidOnly === false) {
      const html = observed?.descriptionHtml || fallback.descriptionHtml;
      try {
        if (typeof html === "string" && html.length <= MAX_DESCRIPTION_BYTES &&
            new TextEncoder().encode(html).length <= MAX_DESCRIPTION_BYTES) {
          const description = globalThis.LeetGitProblem?.describe(html);
          const markdown = description?.descriptionMarkdown;
          assignDefined(problem, {
            overview: text(description?.overview, 320),
            descriptionMarkdown: typeof markdown === "string" && markdown.length <= MAX_MARKDOWN_BYTES &&
              new TextEncoder().encode(markdown).length <= MAX_MARKDOWN_BYTES ? markdown : undefined,
          });
        }
      } catch {
        // A description conversion failure leaves the solution and other details intact.
      }
    }
    if (!Object.keys(problem).length) return undefined;
    problem.url = `${ORIGIN}/problems/${slug}/`;
    return problem;
  }

  function captureStats(input) {
    if (!input || typeof input !== "object") return undefined;
    const stats = {};
    const runtime = text(input.runtime, 32);
    const memory = text(input.memory, 32);
    if (/^\d{1,8}(?:[.,]\d{1,4})?\s*(?:ms|s|[μµ]s)$/i.test(runtime ?? "")) stats.runtime = runtime;
    if (/^\d{1,8}(?:[.,]\d{1,4})?\s*(?:B|KB|MB|GB)$/i.test(memory ?? "")) stats.memory = memory;
    for (const key of ["runtimePercentile", "memoryPercentile"]) {
      const value = input[key];
      if (Number.isFinite(value) && value >= 0 && value <= 100) stats[key] = value;
    }
    for (const key of ["testsPassed", "totalTests"]) {
      const value = input[key];
      if (Number.isSafeInteger(value) && value >= 0 && value <= 100_000) stats[key] = value;
    }
    if (stats.testsPassed > stats.totalTests) delete stats.testsPassed;
    return Object.keys(stats).length ? stats : undefined;
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== ORIGIN) return;
    if (event.data?.type !== "leetgit:accepted-submission") return;

    const submission = event.data.submission;
    if (!submission || typeof submission !== "object") return;
    const { id, slug, language, code, acceptedAt } = submission;
    if (typeof id !== "string" || !/^[1-9]\d{0,19}$/.test(id)) return;
    if (typeof slug !== "string" || !/^[a-z0-9][a-z0-9-]{0,149}$/.test(slug)) return;
    if (typeof language !== "string" || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(language)) return;
    if (typeof code !== "string" || !code.length || code.length > 256 * 1024) return;
    if (typeof acceptedAt !== "string" || !Number.isFinite(Date.parse(acceptedAt))) return;

    const problem = captureProblem(slug, submission.problem);
    const stats = captureStats(submission.stats);
    void chrome.runtime.sendMessage({
      type: "leetcode.accepted",
      submission: {
        id,
        slug,
        language,
        code,
        url: `${ORIGIN}/problems/${slug}/submissions/${id}/`,
        acceptedAt: new Date(acceptedAt).toISOString(),
        ...(problem && { problem }),
        ...(stats && { stats }),
      },
    }).catch(() => {
      // Tabs opened before an extension reload need a refresh to reconnect.
    });
  });
})();
