import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";

const origin = "https://leetcode.com";
const submitUrl = "/problems/two-sum/submit/";
const bridge = await readFile(new URL("../extension/page-bridge.js", import.meta.url), "utf8");
const content = await readFile(new URL("../extension/leetcode.js", import.meta.url), "utf8");

function page(respond, { pathname, document = {}, describe } = {}) {
  const messages = [];
  const bridgeMessages = [];
  const listeners = [];
  const window = {
    location: { origin, pathname },
    fetch: respond,
    addEventListener(type, listener) {
      if (type === "message") listeners.push(listener);
    },
    postMessage(data, targetOrigin) {
      assert.equal(targetOrigin, origin);
      bridgeMessages.push(structuredClone(data));
      dispatchMessage(data);
    },
  };

  function dispatchMessage(data, event = {}) {
    for (const listener of listeners) listener({ source: window, origin, data, ...event });
  }

  class XMLHttpRequest extends EventTarget {
    open(method, url) {
      this.method = method;
      this.url = url;
    }
    send(body) {
      const { payload, status = 200 } = respond(this.url, { method: this.method, body });
      this.status = status;
      this.response = payload;
      this.responseText = JSON.stringify(payload);
      this.dispatchEvent(new Event("loadend"));
    }
  }

  const globals = { window, XMLHttpRequest, URL, Blob, Request, TextEncoder, setTimeout, clearTimeout,
    document: { baseURI: `${origin}/`, querySelector: () => null, querySelectorAll: () => [], ...document } };
  runInNewContext(bridge, globals);
  runInNewContext(content, {
    window, document: globals.document, URL, TextEncoder, LeetGitProblem: describe ? { describe } : undefined,
    chrome: { runtime: { async sendMessage(message) { messages.push(structuredClone(message)); } } },
  });
  return { window, XMLHttpRequest, dispatchMessage, messages, bridgeMessages };
}

function submitOptions(typed_code, lang = "python3") {
  return { method: "POST", body: JSON.stringify({ lang, typed_code }) };
}

function graphqlOptions(operationName, titleSlug = "two-sum", query) {
  return { method: "POST", body: JSON.stringify({ operationName, variables: { titleSlug }, query }) };
}

test("versioned fetch polls sync the exact submitted source once after Accepted", async () => {
  const code = "# Preserve Unicode and whitespace: café 🚀\nclass Solution:\n    pass\n\n";
  const checks = [{ state: "PENDING" }, { state: "SUCCESS", status_code: 10 }];
  const { window, messages } = page(async (url, options) => {
    if (url === submitUrl) {
      assert.equal(JSON.parse(options.body).typed_code, code);
      return Response.json({ submission_id: 981 });
    }
    assert.equal(url, "/submissions/detail/981/v2/check/?lang=python3");
    return Response.json(checks.length ? checks.shift() : { state: "SUCCESS", status_code: 10 });
  });

  const response = await window.fetch(submitUrl, submitOptions(code));
  assert.deepEqual(await response.json(), { submission_id: 981 });
  const check = "/submissions/detail/981/v2/check/?lang=python3";
  await window.fetch(check);
  await setImmediate();
  assert.equal(messages.length, 0);
  await window.fetch(check);
  await window.fetch(check);
  await setImmediate();
  assert.equal(messages.length, 1);
  assert.equal(new Date(messages[0].submission.acceptedAt).toISOString(), messages[0].submission.acceptedAt);
  assert.deepEqual(messages[0], {
    type: "leetcode.accepted",
    submission: {
      id: "981", slug: "two-sum", language: "python3", code,
      url: `${origin}/problems/two-sum/submissions/981/`,
      acceptedAt: messages[0].submission.acceptedAt,
    },
  });
});

test("request bodies and out-of-order observations correlate by submission ID", async () => {
  let readSubmitResponse;
  const gate = new Promise((resolve) => { readSubmitResponse = resolve; });
  const first = "first code\n";
  const second = "second code\n";
  const request = new Request(origin + submitUrl, submitOptions(first));
  const { window, messages } = page(async (url) => {
    if (url === request) {
      assert.equal((await url.json()).typed_code, first);
      return { ok: true, clone: () => ({ json: () => gate }) };
    }
    if (url === submitUrl) return Response.json({ submission_id: "102" });
    return Response.json({ state: "SUCCESS", status_msg: "Accepted" });
  });

  await window.fetch(request);
  await window.fetch(submitUrl, submitOptions(second, "javascript"));
  await window.fetch("/submissions/detail/101/check/");
  await window.fetch("/submissions/detail/102/check/");
  await setImmediate();
  assert.equal(messages.length, 1);
  readSubmitResponse({ submission_id: "101" });
  await setImmediate();
  assert.deepEqual(messages.map(({ submission }) => [submission.id, submission.code]), [
    ["102", second], ["101", first],
  ]);
});

test("XHR only syncs an accepted practice submission correlated to the posted code", async () => {
  const { XMLHttpRequest, messages } = page((url, options) => {
    const checks = {
      "/submissions/detail/201/check/": { state: "SUCCESS", status_code: 11, status_msg: "Wrong Answer" },
      "/submissions/detail/202/check/": { state: "SUCCESS", status_code: 10 },
      "/submissions/detail/203/check/": { state: "SUCCESS", status_code: 10, submission_id: 202 },
      "/submissions/detail/204/check/": { state: "SUCCESS", status_code: 10, submission_id: 204 },
      "/submissions/detail/205/check/": { state: "SUCCESS", status_code: 10 },
      "/submissions/detail/206/check/": { state: "SUCCESS", status_code: 10 },
    };
    if (options.method === "POST") return { payload: { submission_id: Number(JSON.parse(options.body).typed_code) } };
    return { payload: checks[url] };
  });

  const xhr = new XMLHttpRequest();
  function complete(method, url, body, type = "") {
    xhr.open(method, url);
    xhr.responseType = type;
    xhr.send(body);
  }
  complete("POST", submitUrl, submitOptions("201").body);
  complete("POST", "/problems/two-sum/interpret_solution/", submitOptions("202").body);
  complete("POST", submitUrl, submitOptions("203").body);
  complete("POST", submitUrl, submitOptions("204", "cpp").body, "json");
  complete("POST", "https://other.example/problems/two-sum/submit/", submitOptions("205").body);
  complete("POST", "/contest/weekly-contest-123/problems/two-sum/submit/", submitOptions("206").body);
  for (let id = 201; id <= 206; id += 1) complete("GET", `/submissions/detail/${id}/check/`);
  await setImmediate();
  assert.deepEqual(messages.map(({ submission }) => [submission.id, submission.language, submission.code]), [
    ["204", "cpp", "204"],
  ]);
});

test("the isolated script ignores frames, foreign origins, and unsafe submission fields", () => {
  const { dispatchMessage, messages } = page(() => { throw new Error("No request expected"); });
  const packet = {
    type: "leetgit:accepted-submission",
    submission: {
      id: "981", slug: "two-sum", language: "python3", code: "valid-code\n",
      url: "https://other.example/", acceptedAt: "2026-11-20T10:00:00-05:00",
    },
  };
  dispatchMessage(packet, { origin: "https://other.example" });
  dispatchMessage(packet, { source: {} });
  dispatchMessage({ ...packet, submission: { ...packet.submission, slug: "../../.github" } });
  dispatchMessage({ ...packet, submission: { ...packet.submission, language: "/tmp" } });
  assert.equal(messages.length, 0);
  dispatchMessage(packet);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].submission.url, `${origin}/problems/two-sum/submissions/981/`);
  assert.equal(messages[0].submission.acceptedAt, "2026-11-20T15:00:00.000Z");
});

test("accepted source is enriched from related page-owned GraphQL and final judge results", async () => {
  const code = "# source stays exact  \n";
  const html = "<p>A synthetic problem statement.</p>";
  const calls = [];
  const descriptions = [];
  const { window, messages } = page(async (url, options) => {
    calls.push(url);
    if (url === "/graphql/") {
      const { operationName, variables } = JSON.parse(options.body);
      const question = {
        questionTitle: { title: "Two Sum", titleSlug: variables.titleSlug, frontendQuestionId: "1", questionId: "9001",
          difficulty: "easy", isPaidOnly: false },
        questionContent: { content: html },
        singleQuestionTopicTags: { topicTags: [{ name: "Array" }, { name: "Hash Table" }, { name: "Array" }] },
      }[operationName];
      return Response.json({ data: { question } });
    }
    if (url === submitUrl) return Response.json({ submission_id: 301 });
    assert.equal(url, "/submissions/detail/301/v2/check/");
    return Response.json({ state: "SUCCESS", status_code: 10, status_runtime: "2 ms", status_memory: "15.4 MB",
      runtime_percentile: "98.18%", memory_percentile: 0, total_correct: "63", total_testcases: 63 });
  }, { describe: input => {
    descriptions.push(input);
    return { overview: "A synthetic problem statement.", descriptionMarkdown: "A synthetic problem statement.\n" };
  } });

  for (const operation of ["questionContent", "singleQuestionTopicTags", "questionTitle"]) {
    const response = await window.fetch("/graphql/", graphqlOptions(operation));
    assert.ok((await response.json()).data.question);
    await setImmediate();
  }
  await window.fetch(submitUrl, submitOptions(code));
  await window.fetch("/submissions/detail/301/v2/check/");
  await setImmediate();
  assert.deepEqual(calls, ["/graphql/", "/graphql/", "/graphql/", submitUrl, "/submissions/detail/301/v2/check/"]);
  assert.deepEqual(descriptions, [html]);
  const { submission } = messages[0];
  assert.equal(submission.code, code);
  assert.deepEqual(submission.problem, {
    title: "Two Sum", frontendId: "1", difficulty: "Easy", paidOnly: false,
    topics: ["Array", "Hash Table"], overview: "A synthetic problem statement.",
    descriptionMarkdown: "A synthetic problem statement.\n", url: `${origin}/problems/two-sum/`,
  });
  assert.deepEqual(submission.stats, {
    runtime: "2 ms", memory: "15.4 MB", runtimePercentile: 98.18, memoryPercentile: 0, testsPassed: 63, totalTests: 63,
  });
});

test("non-problem operations and premium descriptions stay outside the submission", async () => {
  let unrelatedClones = 0;
  const { window, messages, bridgeMessages } = page(async (url, options) => {
    if (url === "/graphql/") {
      const { operationName } = JSON.parse(options.body);
      if (operationName === "accountData") {
        return { ok: true, clone() { unrelatedClones += 1; return Response.json({}); } };
      }
      if (operationName === "questionContent") {
        return Response.json({ data: { question: { content: "<p>Payment required</p>" } } });
      }
      return Response.json({ data: { question: { title: "A paid problem", titleSlug: "two-sum",
        questionFrontendId: 991, difficulty: "Hard", isPaidOnly: true } } });
    }
    if (url === submitUrl) return Response.json({ submission_id: 302 });
    return Response.json({ state: "SUCCESS", status_code: 10, runtimePercentile: -1, memoryPercentile: 102,
      runtimeDisplay: "<img>", memoryDisplay: "20 KB", totalCorrect: 15, totalTestcases: 2 });
  }, { describe: () => assert.fail("A premium problem must not be converted") });

  await window.fetch("/graphql/", graphqlOptions("accountData", "two-sum", "query accountData { account { username } }"));
  await window.fetch("/graphql/", graphqlOptions("questionContent"));
  await setImmediate();
  await window.fetch("/graphql/", graphqlOptions("questionData"));
  await window.fetch(submitUrl, submitOptions("accepted\n"));
  await window.fetch("/submissions/detail/302/v2/check/");
  await setImmediate();
  assert.equal(unrelatedClones, 0);
  assert.equal(bridgeMessages[0].submission.problem.descriptionHtml, undefined);
  assert.deepEqual(messages[0].submission.problem, {
    title: "A paid problem", frontendId: "991", difficulty: "Hard", paidOnly: true, url: `${origin}/problems/two-sum/`,
  });
  assert.deepEqual(messages[0].submission.stats, { memory: "20 KB", totalTests: 2 });
});

test("unclassified problem text never leaves the page bridge", async () => {
  const { window, messages, bridgeMessages } = page(async url => {
    if (url === "/graphql/") return Response.json({ data: { question: { content: "<p>Unknown access</p>" } } });
    if (url === submitUrl) return Response.json({ submission_id: 308 });
    return Response.json({ state: "SUCCESS", status_code: 10 });
  }, { describe: () => assert.fail("Unknown problem access must not be converted") });

  await window.fetch("/graphql/", graphqlOptions("questionContent"));
  await window.fetch(submitUrl, submitOptions("saved regardless\n"));
  await window.fetch("/submissions/detail/308/check/");
  await setImmediate();
  assert.equal(messages.length, 1);
  assert.equal(bridgeMessages[0].submission.problem, undefined);
  assert.equal(messages[0].submission.problem, undefined);
});

test("the current page-owned submission details query fills missing runtime and memory statistics", async () => {
  const calls = [];
  let historicalClones = 0;
  const { window, messages } = page(async (url, options) => {
    calls.push(url);
    if (url === submitUrl) return Response.json({ submission_id: 307 });
    if (url === "/submissions/detail/307/v2/check/") {
      return Response.json({ state: "SUCCESS", status_code: 10, total_correct: 66, total_testcases: 66 });
    }
    assert.equal(url, "/graphql/");
    const id = JSON.parse(options.body).variables.submissionId;
    if (id !== 307) return { ok: true, clone() { historicalClones += 1; return Response.json({}); } };
    return Response.json({ data: { submissionDetails: { statusCode: 10, runtimeDisplay: "12 ms",
      memoryDisplay: "17.2 MB", runtimePercentile: 95.47, memoryPercentile: 74, code: "Do not use this source" } } });
  }, { pathname: "/problems/two-sum/submissions/307/" });
  const submissionDetails = id => ({ method: "POST", body: JSON.stringify({
    operationName: "submissionDetails", variables: { submissionId: id },
  }) });

  const code = "exact source from Submit\n";
  await window.fetch(submitUrl, submitOptions(code));
  await window.fetch("/submissions/detail/307/v2/check/");
  await setImmediate();
  assert.equal(messages.length, 0);
  await window.fetch("/graphql/", submissionDetails(123));
  await window.fetch("/graphql/", submissionDetails(307));
  await setImmediate();
  assert.equal(historicalClones, 0);
  assert.equal(messages.length, 1);
  assert.deepEqual(calls, [submitUrl, "/submissions/detail/307/v2/check/", "/graphql/", "/graphql/"]);
  assert.equal(messages[0].submission.code, code);
  assert.deepEqual(messages[0].submission.stats, { runtime: "12 ms", memory: "17.2 MB",
    runtimePercentile: 95.47, memoryPercentile: 74, testsPassed: 66, totalTests: 66 });
});

test("rendered fallback stays on the submitted problem and requires explicit non-premium status for text", () => {
  const html = "<p>Visible statement</p>";
  let reads = 0;
  const { window, dispatchMessage, messages } = page(() => assert.fail("No metadata request expected"), {
    pathname: "/problems/two-sum/submissions/303/",
    document: {
      querySelectorAll: () => [
        { href: `${origin}/problems/two-sum-extended/`, textContent: "111. Another Problem" },
        { href: `${origin}/problems/two-sum/description?envType=study-plan-v2`, textContent: "1. Two Sum" },
      ],
      querySelector(selector) {
        if (selector.includes("data-difficulty")) return { textContent: "Easy" };
        if (selector.includes("description_content")) {
          reads += 1;
          return { innerHTML: html, checkVisibility: () => true };
        }
        return null;
      },
    },
    describe: input => { assert.equal(input, html); return { overview: "Visible statement" }; },
  });
  function acceptance(id, problem) {
    dispatchMessage({ type: "leetgit:accepted-submission", submission: {
      id, slug: "two-sum", language: "python3", code: "source\n", acceptedAt: "2026-11-20T15:00:00.000Z", problem,
    } });
  }
  acceptance("303");
  acceptance("304", { paidOnly: false });
  window.location.pathname = "/problems/other-question/";
  acceptance("305", { paidOnly: false });
  assert.equal(reads, 1);
  assert.deepEqual(messages[0].submission.problem, {
    title: "Two Sum", frontendId: "1", difficulty: "Easy", url: `${origin}/problems/two-sum/`,
  });
  assert.equal(messages[1].submission.problem.overview, "Visible statement");
  assert.deepEqual(messages[2].submission.problem, { paidOnly: false, url: `${origin}/problems/two-sum/` });
});

test("missing or slow metadata cannot block an accepted solution", async () => {
  let completeMetadata;
  const pending = new Promise(resolve => { completeMetadata = resolve; });
  const { window, messages } = page(async url => {
    if (url === "/graphql/") return { ok: true, clone: () => ({ json: () => pending }) };
    if (url === submitUrl) return Response.json({ submission_id: 306 });
    return Response.json({ state: "SUCCESS", status_code: 10 });
  }, { pathname: "/problems/two-sum/submissions/306/" });
  await window.fetch("/graphql/", graphqlOptions("questionData"));
  await window.fetch(submitUrl, submitOptions("saved regardless\n"));
  await window.fetch("/submissions/detail/306/check/");
  await delay(700);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].submission.code, "saved regardless\n");
  assert.equal(messages[0].submission.problem, undefined);
  completeMetadata({});
  await setImmediate();
  assert.equal(messages.length, 1);
});
