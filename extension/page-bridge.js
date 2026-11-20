(() => {
  const EVENT = "leetgit:accepted-submission";
  const MAX_TRACKED = 64;
  const MAX_AGE_MS = 10 * 60 * 1000;
  const MAX_PROBLEMS = 12;
  const MAX_DESCRIPTION_BYTES = 120 * 1024;
  const PROBLEM_WAIT_MS = 350;
  const DETAILS_WAIT_MS = 600;
  const problemSlug = /^[a-z0-9][a-z0-9-]{0,149}$/;
  const questionOperations = new Set(["questionData", "questionDetail", "questionTitle", "questionContent",
    "singleQuestionTopicTags", "questionTopicTags"]);
  const measurementFields = ["runtime", "memory", "runtimePercentile", "memoryPercentile"];
  const origin = window.location.origin;
  const submissions = new Map();
  const problems = new Map();
  const problemRequests = new Map();

  function requestRoute(resource, method = "GET") {
    const url = new URL(resource, document.baseURI);
    if (url.origin !== origin) return null;

    const verb = method.toUpperCase();
    if (url.pathname === "/graphql" || url.pathname === "/graphql/") {
      if (verb === "POST") return { graphql: true };
      if (verb === "GET") return { graphql: true, query: {
        operationName: url.searchParams.get("operationName"),
        query: url.searchParams.get("query"),
        variables: parseJson(url.searchParams.get("variables")),
      } };
    }
    if (verb === "POST") {
      const match = /^\/problems\/([a-z0-9][a-z0-9-]{0,149})\/submit\/?$/.exec(url.pathname);
      if (match) return { slug: match[1] };
    }
    if (verb === "GET") {
      const match = /^\/submissions\/detail\/([1-9]\d{0,19})\/(?:v\d+\/)?check\/?$/.exec(url.pathname);
      if (match) return { id: match[1] };
    }
    return null;
  }

  function parseJson(text) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function readBody(body) {
    if (typeof body === "string") return parseJson(body);
    if (body instanceof Blob) return body.text().then(parseJson).catch(() => null);
    return null;
  }

  function submissionId(value) {
    if (typeof value !== "string" && !Number.isSafeInteger(value)) return null;
    const id = String(value);
    return /^[1-9]\d{0,19}$/.test(id) ? id : null;
  }

  function questionSlug(input) {
    const slug = input?.variables?.titleSlug;
    if (typeof slug !== "string" || !problemSlug.test(slug)) return null;
    if (questionOperations.has(input.operationName)) return slug;
    const query = input.query;
    if (typeof query === "string" && /^\s*(?:query\b|\{)/.test(query) &&
        /\bquestion\s*\(\s*titleSlug\s*:/.test(query) &&
        /\b(?:title|questionFrontendId|frontendQuestionId|difficulty|content|topicTags|isPaidOnly)\b/.test(query)) return slug;
    return null;
  }

  function detailId(input) {
    const id = submissionId(input?.variables?.submissionId);
    if (!id) return null;
    if (input.operationName === "submissionDetails") return id;
    const query = input.query;
    if (typeof query === "string" && /^\s*(?:query\b|\{)/.test(query) &&
        /\bsubmissionDetails\s*\(\s*submissionId\s*:/.test(query)) return id;
    return null;
  }

  function text(value, max) {
    if (typeof value !== "string" || value.length > max) return undefined;
    return value.replace(/\s+/g, " ").trim() || undefined;
  }

  function observeProblem(slug, response) {
    // Only cache fields belonging to the problem referenced by this page-owned query.
    const task = Promise.resolve(response).then((result) => {
      const question = result?.data?.question;
      if (!question || (question.titleSlug != null && question.titleSlug !== slug)) return;
      const problem = { ...problems.get(slug) };
      const title = text(question.title, 200);
      const displayedId = question.questionFrontendId ?? question.frontendQuestionId;
      const frontendId = text(Number.isSafeInteger(displayedId) ? String(displayedId) : displayedId, 32);
      const difficulty = text(question.difficulty, 10);
      if (title) problem.title = title;
      if (frontendId) problem.frontendId = frontendId;
      if (difficulty && /^(?:Easy|Medium|Hard)$/i.test(difficulty)) problem.difficulty = difficulty;
      if (typeof question.isPaidOnly === "boolean") problem.paidOnly = question.isPaidOnly;
      if (Array.isArray(question.topicTags)) {
        const topics = question.topicTags.slice(0, 24).map(tag => text(tag?.name, 80)).filter(Boolean);
        if (topics.length) problem.topics = [...new Set(topics)];
      }
      if (problem.paidOnly !== true && typeof question.content === "string" &&
          question.content.length <= MAX_DESCRIPTION_BYTES &&
          new TextEncoder().encode(question.content).length <= MAX_DESCRIPTION_BYTES) {
        problem.descriptionHtml = question.content;
      }
      if (problem.paidOnly === true) delete problem.descriptionHtml;
      if (!Object.keys(problem).length) return;
      problems.delete(slug);
      problems.set(slug, problem);
      if (problems.size > MAX_PROBLEMS) problems.delete(problems.keys().next().value);
    }).catch(() => {
      // Metadata is optional when LeetCode changes the question schema.
    });

    const pending = problemRequests.get(slug) ?? new Set();
    pending.add(task);
    problemRequests.set(slug, pending);
    void task.then(() => {
      pending.delete(task);
      if (!pending.size) problemRequests.delete(slug);
    });
  }

  function percentile(value) {
    if (typeof value === "string" && /^\d+(?:\.\d+)?%?$/.test(value.trim())) {
      value = Number(value.trim().replace(/%$/, ""));
    }
    return Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined;
  }

  function testCount(value) {
    if (typeof value === "string" && /^\d{1,6}$/.test(value)) value = Number(value);
    return Number.isSafeInteger(value) && value >= 0 && value <= 100_000 ? value : undefined;
  }

  function submissionStats(result) {
    const runtime = text(result.status_runtime ?? result.runtimeDisplay ?? result.runtime_display, 32);
    const memory = text(result.status_memory ?? result.memoryDisplay ?? result.memory_display, 32);
    const stats = {
      runtime: /^\d{1,8}(?:[.,]\d{1,4})?\s*(?:ms|s|[μµ]s)$/i.test(runtime ?? "") ? runtime : undefined,
      memory: /^\d{1,8}(?:[.,]\d{1,4})?\s*(?:B|KB|MB|GB)$/i.test(memory ?? "") ? memory : undefined,
      runtimePercentile: percentile(result.runtime_percentile ?? result.runtimePercentile),
      memoryPercentile: percentile(result.memory_percentile ?? result.memoryPercentile),
      testsPassed: testCount(result.total_correct ?? result.totalCorrect),
      totalTests: testCount(result.total_testcases ?? result.totalTestcases),
    };
    if (stats.testsPassed > stats.totalTests) delete stats.testsPassed;
    for (const key of Object.keys(stats)) {
      if (stats[key] === undefined) delete stats[key];
    }
    return Object.keys(stats).length ? stats : undefined;
  }

  function observeDetails(id, readResponse) {
    const tracked = submissions.get(id);
    if (!tracked?.source && !tracked?.finishDetails) return;

    void Promise.resolve(readResponse()).then(result => {
      const current = submissions.get(id);
      if (!current?.source && !current?.finishDetails) return;
      const details = result?.data?.submissionDetails;
      if (!details || (details.statusCode != null && details.statusCode !== 10 && details.statusCode !== "10")) return;
      const stats = submissionStats(details);
      if (stats) current.details = { ...current.details, ...stats };
      current.finishDetails?.(current.details);
    }).catch(() => {
      // The terminal poll remains the source of the accepted verdict and exact code.
    });
  }

  async function waitBriefly(task, milliseconds) {
    let timeout;
    await Promise.race([
      task,
      new Promise(resolve => { timeout = setTimeout(resolve, milliseconds); }),
    ]);
    clearTimeout(timeout);
  }

  async function publish(id, entry, tracked) {
    const { slug, language, code } = entry.source;
    const pending = problemRequests.get(slug);
    const waits = [];
    if (pending?.size) waits.push(waitBriefly(Promise.all(pending), PROBLEM_WAIT_MS));

    const path = window.location.pathname;
    const problemPath = `/problems/${slug}`;
    const statsFromPoll = { ...entry.stats, ...tracked.details };
    if ((path === problemPath || path?.startsWith(`${problemPath}/`)) &&
        measurementFields.some(key => statsFromPoll[key] === undefined)) {
      // The page may load its own submissionDetails query after rendering the verdict.
      const detail = new Promise(resolve => {
        tracked.finishDetails = stats => {
          if (measurementFields.every(key => statsFromPoll[key] !== undefined || stats?.[key] !== undefined)) resolve();
        };
      });
      waits.push(waitBriefly(detail, DETAILS_WAIT_MS));
    }
    if (waits.length) await Promise.all(waits);
    delete tracked.finishDetails;

    const stats = { ...entry.stats, ...tracked.details };
    delete tracked.details;
    const { descriptionHtml, ...problem } = problems.get(slug) ?? {};
    if (problem.paidOnly === false && descriptionHtml) problem.descriptionHtml = descriptionHtml;

    window.postMessage({
      type: EVENT,
      submission: {
        id, slug, language, code, acceptedAt: entry.acceptedAt,
        ...(Object.keys(problem).length && { problem }),
        ...(Object.keys(stats).length && { stats }),
      },
    }, origin);
  }

  // The check response can arrive before the cloned submit body has finished reading.
  function record(id, update) {
    const now = Date.now();
    for (const [key, entry] of submissions) {
      if (entry.expires <= now) submissions.delete(key);
    }

    const previous = submissions.get(id);
    if (previous?.settled) return;
    const entry = { ...previous, ...update, expires: now + MAX_AGE_MS };
    if (entry.source && entry.verdict !== undefined) {
      const tracked = { settled: true, expires: entry.expires, details: entry.verdict ? entry.details : undefined };
      submissions.set(id, tracked);
      if (entry.verdict === true) void publish(id, entry, tracked).catch(() => {});
    } else {
      submissions.set(id, entry);
    }
    if (submissions.size > MAX_TRACKED) {
      submissions.delete(submissions.keys().next().value);
    }
  }

  function observe(route, response, body) {
    void Promise.all([response, body]).then(([result, input]) => {
      if (!result) return;
      if (route.slug) {
        const id = submissionId(result.submission_id);
        if (id && typeof input?.lang === "string" && typeof input.typed_code === "string") {
          record(id, { source: { slug: route.slug, language: input.lang, code: input.typed_code } });
        }
        return;
      }

      if (result.state !== "SUCCESS" && result.state !== "FAILURE") return;
      if (result.submission_id != null && submissionId(result.submission_id) !== route.id) return;
      const accepted = result.status_code == null
        ? result.status_msg === "Accepted"
        : result.status_code === 10 || result.status_code === "10";
      record(route.id, {
        verdict: result.state === "SUCCESS" && accepted,
        acceptedAt: new Date().toISOString(),
        stats: accepted ? submissionStats(result) : undefined,
      });
    }).catch(() => {
      // A browser or endpoint change must not interrupt LeetCode's own request.
    });
  }

  function observeRequest(route, body, readResponse) {
    if (!route.graphql) {
      observe(route, readResponse(), body);
      return;
    }
    const load = input => {
      const slug = questionSlug(input);
      if (slug) {
        observeProblem(slug, readResponse());
        return;
      }
      const id = detailId(input);
      if (id) observeDetails(id, readResponse);
    };
    if (typeof body?.then === "function") void body.then(load).catch(() => {});
    else load(route.query ?? body);
  }

  const fetchPage = window.fetch;
  window.fetch = function (resource, options) {
    let route;
    let payload;
    try {
      const request = resource instanceof Request ? resource : null;
      route = requestRoute(request?.url ?? resource, options?.method ?? request?.method);
      if (route?.slug || (route?.graphql && !route.query)) {
        const body = options?.body;
        payload = body == null && request?.body
          ? request.clone().json().catch(() => null)
          : readBody(body);
      }
    } catch {
      // Forward the original arguments even when they cannot be observed.
    }

    const response = Reflect.apply(fetchPage, this, arguments);
    if (route) observeRequest(route, payload, () => response.then((reply) => reply.ok ? reply.clone().json() : null));
    return response;
  };

  const xhr = XMLHttpRequest.prototype;
  const open = xhr.open;
  const send = xhr.send;
  const routes = new WeakMap();

  xhr.open = function (method, url) {
    const result = Reflect.apply(open, this, arguments);
    routes.delete(this);
    try {
      const route = requestRoute(url, method);
      if (route) routes.set(this, route);
    } catch {
      // Ignore requests that cannot be classified.
    }
    return result;
  };

  xhr.send = function (body) {
    const route = routes.get(this);
    if (!route) return Reflect.apply(send, this, arguments);

    let payload;
    try {
      if (route.slug || (route.graphql && !route.query)) payload = readBody(body);
    } catch {
      return Reflect.apply(send, this, arguments);
    }
    const onFinished = () => {
      if (routes.get(this) !== route || this.status < 200 || this.status >= 300) return;
      if (this.responseType === "json") {
        const response = this.response;
        observeRequest(route, payload, () => response);
      } else if (!this.responseType || this.responseType === "text") {
        const response = this.responseText;
        observeRequest(route, payload, () => parseJson(response));
      }
    };
    this.addEventListener("loadend", onFinished, { once: true });
    try {
      return Reflect.apply(send, this, arguments);
    } catch (error) {
      this.removeEventListener("loadend", onFinished);
      throw error;
    }
  };
})();
