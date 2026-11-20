import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";

const origin = "https://leetcode.com";
const submitUrl = "/problems/two-sum/submit/";
const bridge = await readFile(new URL("../extension/page-bridge.js", import.meta.url), "utf8");
const content = await readFile(new URL("../extension/leetcode.js", import.meta.url), "utf8");

function page(respond) {
  const messages = [];
  const listeners = [];
  const window = {
    location: { origin },
    fetch: respond,
    addEventListener(type, listener) {
      if (type === "message") listeners.push(listener);
    },
    postMessage(data, targetOrigin) {
      assert.equal(targetOrigin, origin);
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

  const globals = { window, XMLHttpRequest, URL, Blob, Request, document: { baseURI: `${origin}/` } };
  runInNewContext(bridge, globals);
  runInNewContext(content, {
    window,
    chrome: { runtime: { async sendMessage(message) { messages.push(structuredClone(message)); } } },
  });
  return { window, XMLHttpRequest, dispatchMessage, messages };
}

function submitOptions(typed_code, lang = "python3") {
  return { method: "POST", body: JSON.stringify({ lang, typed_code }) };
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
