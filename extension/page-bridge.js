(() => {
  const EVENT = "leetgit:accepted-submission";
  const MAX_TRACKED = 64;
  const MAX_AGE_MS = 10 * 60 * 1000;
  const origin = window.location.origin;
  const submissions = new Map();

  function requestRoute(resource, method = "GET") {
    const url = new URL(resource, document.baseURI);
    if (url.origin !== origin) return null;

    const verb = method.toUpperCase();
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
      if (entry.verdict === true) {
        const { slug, language, code } = entry.source;
        window.postMessage({
          type: EVENT,
          submission: {
            id,
            slug,
            language,
            code,
            acceptedAt: entry.acceptedAt,
          },
        }, origin);
      }
      submissions.set(id, { settled: true, expires: entry.expires });
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
      });
    }).catch(() => {
      // A browser or endpoint change must not interrupt LeetCode's own request.
    });
  }

  const fetchPage = window.fetch;
  window.fetch = function (resource, options) {
    let route;
    let payload;
    try {
      const request = resource instanceof Request ? resource : null;
      route = requestRoute(request?.url ?? resource, options?.method ?? request?.method);
      if (route?.slug) {
        payload = options?.body == null && request?.body
          ? request.clone().json().catch(() => null)
          : readBody(options?.body);
      }
    } catch {
      // Forward the original arguments even when they cannot be observed.
    }

    const response = Reflect.apply(fetchPage, this, arguments);
    if (route) observe(route, response.then((reply) => reply.ok ? reply.clone().json() : null), payload);
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
      if (route.slug) payload = readBody(body);
    } catch {
      return Reflect.apply(send, this, arguments);
    }
    const onFinished = () => {
      if (routes.get(this) !== route || this.status < 200 || this.status >= 300) return;
      if (this.responseType === "json") {
        observe(route, this.response, payload);
      } else if (!this.responseType || this.responseType === "text") {
        observe(route, parseJson(this.responseText), payload);
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
