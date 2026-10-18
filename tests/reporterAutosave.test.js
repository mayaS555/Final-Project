// Tests for public/js/reporter-autosave.js (owned by B). The real script runs in a vm context with a small fake
// page (form, fields, status line, event listeners), a fake fetch and Node's mock timers, so no browser is needed.
// Run: node --test tests/

const { describe, test, beforeEach, afterEach, mock } = require("node:test");
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SCRIPT = fs.readFileSync(path.join(__dirname, "..", "public", "js", "reporter-autosave.js"), "utf8");
const FIELD_NAMES = ["title", "summary", "content", "imageUrl", "category"];

/**
 * A successful PATCH answer.
 * @param {string} [savedAt] The savedAt the server sends back.
 * @returns {Promise<Object>} A fetch-like response.
 * @example fetchAnswers.push(saved());
 */
function saved(savedAt = "2026-10-18T09:30:00.000Z") {
  return Promise.resolve({ ok: true, status: 200, json: async () => ({ savedAt }) });
}

/**
 * A failed PATCH answer.
 * @param {number} status The HTTP status.
 * @param {string} [error] The error message in the body.
 * @returns {Promise<Object>} A fetch-like response.
 * @example fetchAnswers.push(failed(409));
 */
function failed(status, error = "Something is wrong.") {
  return Promise.resolve({ ok: false, status, json: async () => ({ error }) });
}

/**
 * A network failure (fetch rejects). Pass the function itself to loadPage, so the rejection is created only when fetch asks.
 * @returns {Promise<never>} A rejected promise.
 * @example loadPage([offline, saved]);
 */
function offline() {
  return Promise.reject(new TypeError("Failed to fetch"));
}

/**
 * Lets pending promises (fetch answers, response.json) finish.
 * @returns {Promise<void>}
 * @example await settle();
 */
function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Loads the script into a fake edit page.
 * @param {Array<Promise|Function>} fetchAnswers Answers for the next fetch calls, in order. A function is called
 *   to create the answer (for answers that are resolved later). Without answers, fetch answers "saved".
 * @returns {Object} { requests, status, fieldset, document, type, fire }.
 * @example const page = loadPage([saved()]);
 */
function loadPage(fetchAnswers = []) {
  const listeners = { form: {}, document: {}, window: {} };
  const eventTarget = (owner) => ({
    addEventListener(type, handler) {
      (listeners[owner][type] = listeners[owner][type] || []).push(handler);
    },
  });

  const fields = {};
  for (const name of FIELD_NAMES) {
    fields[name] = { name, value: "" };
  }
  const fieldset = { disabled: false };
  const form = { ...eventTarget("form"), dataset: { articleId: "a1" }, elements: fields, querySelector: () => fieldset };
  const status = {
    textContent: "",
    dataset: {},
    hasErrorClass: false,
    classList: {
      toggle(className, on) {
        status.hasErrorClass = on;
      },
    },
  };
  const elements = { "rep-edit-form": form, "rep-save-status": status };
  const document = { ...eventTarget("document"), visibilityState: "visible", getElementById: (id) => elements[id] };
  const requests = [];

  const fakeFetch = (url, options) => {
    requests.push({ url, method: options.method, keepalive: options.keepalive, body: JSON.parse(options.body), headers: options.headers });
    const answer = fetchAnswers.shift();
    if (answer === undefined) {
      return saved();
    }
    return typeof answer === "function" ? answer() : answer;
  };

  const context = vm.createContext({
    document,
    window: eventTarget("window"),
    fetch: fakeFetch,
    setTimeout,
    clearTimeout,
    Blob,
    Date,
  });
  vm.runInContext(SCRIPT, context);

  /**
   * Fires an event on the form, the document or the window.
   * @param {string} owner "form", "document" or "window".
   * @param {string} type The event type.
   * @param {Object} [event] The event object.
   * @returns {Object} The event object (to check preventDefault).
   */
  function fire(owner, type, event = {}) {
    for (const handler of listeners[owner][type] || []) {
      handler(event);
    }
    return event;
  }

  /**
   * Changes a field as if the user typed, which fires "input" on the form.
   * @param {string} name The field name.
   * @param {string} value The new value.
   * @returns {void}
   */
  function type(name, value) {
    fields[name].value = value;
    fire("form", "input", { target: fields[name] });
  }

  return { requests, status, fieldset, document, type, fire };
}

/**
 * A fake beforeunload event that records preventDefault.
 * @returns {Object} The event.
 * @example const event = page.fire("window", "beforeunload", beforeUnloadEvent());
 */
function beforeUnloadEvent() {
  return {
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
}

describe("reporter autosave", () => {
  beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
  afterEach(() => mock.timers.reset());

  test("saves once, 1.5 seconds after the last change", async () => {
    const page = loadPage();
    page.type("title", "H");
    mock.timers.tick(1000);
    page.type("title", "Ha");
    mock.timers.tick(1499);
    assert.equal(page.requests.length, 0);
    mock.timers.tick(1);
    assert.equal(page.requests.length, 1);
    assert.deepEqual(page.requests[0], {
      url: "/api/articles/a1",
      method: "PATCH",
      keepalive: false,
      body: { title: "Ha" },
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(page.status.textContent, "Saving…");
    await settle();
    assert.equal(page.status.dataset.state, "saved");
    assert.match(page.status.textContent, /^Saved at \d{1,2}:\d{2}/);
  });

  test("sends only the fields that changed since the last save", async () => {
    const page = loadPage();
    page.type("title", "Storm");
    mock.timers.tick(1500);
    await settle();
    page.type("summary", "Short");
    page.type("category", "Sports");
    mock.timers.tick(1500);
    assert.deepEqual(page.requests[1].body, { summary: "Short", category: "Sports" });
  });

  test("ignores input from elements that are not article fields", () => {
    const page = loadPage();
    page.fire("form", "input", { target: { name: "search", value: "x" } });
    mock.timers.tick(5000);
    assert.equal(page.requests.length, 0);
  });

  test("never runs two saves at once; changes made meanwhile are sent right after", async () => {
    let finishFirst;
    const page = loadPage([() => new Promise((resolve) => (finishFirst = resolve))]);
    page.type("title", "First");
    mock.timers.tick(1500);
    page.type("content", "Typed during the save");
    mock.timers.tick(1500);
    assert.equal(page.requests.length, 1);

    finishFirst({ ok: true, status: 200, json: async () => ({ savedAt: "2026-10-18T09:30:00.000Z" }) });
    await settle();
    assert.equal(page.requests.length, 2);
    assert.deepEqual(page.requests[1].body, { content: "Typed during the save" });
  });

  test("offline: keeps the data, shows the offline state and retries with growing waits", async () => {
    const page = loadPage([offline, offline, saved]);
    page.type("title", "Kept");
    mock.timers.tick(1500);
    await settle();
    assert.equal(page.status.textContent, "Offline – will retry");

    mock.timers.tick(1999);
    assert.equal(page.requests.length, 1);
    mock.timers.tick(1);
    assert.equal(page.requests.length, 2);
    assert.deepEqual(page.requests[1].body, { title: "Kept" });
    await settle();

    mock.timers.tick(3999);
    assert.equal(page.requests.length, 2);
    mock.timers.tick(1);
    assert.equal(page.requests.length, 3);
    await settle();
    assert.equal(page.status.dataset.state, "saved");
  });

  test("a server error is retried like a network failure", async () => {
    const page = loadPage([failed(500)]);
    page.type("title", "Kept");
    mock.timers.tick(1500);
    await settle();
    assert.equal(page.status.dataset.state, "offline");
    mock.timers.tick(2000);
    assert.equal(page.requests.length, 2);
  });

  for (const status of [403, 409]) {
    test(`${status}: stops autosaving, locks the fields and asks to reload`, async () => {
      const page = loadPage([failed(status)]);
      page.type("title", "Late");
      mock.timers.tick(1500);
      await settle();
      assert.equal(page.status.dataset.state, "stopped");
      assert.match(page.status.textContent, /Reload the page/);
      assert.equal(page.status.hasErrorClass, true);
      assert.equal(page.fieldset.disabled, true);

      page.type("title", "Later");
      mock.timers.tick(60000);
      page.fire("window", "online");
      assert.equal(page.requests.length, 1);
      assert.equal(page.fire("window", "beforeunload", beforeUnloadEvent()).prevented, true);
    });
  }

  test("401: stops and says the user is no longer logged in", async () => {
    const page = loadPage([failed(401)]);
    page.type("title", "x");
    mock.timers.tick(1500);
    await settle();
    assert.equal(page.status.dataset.state, "stopped");
    assert.match(page.status.textContent, /no longer logged in/);
  });

  test("400: shows the server's message and waits for the next change instead of retrying", async () => {
    const page = loadPage([failed(400, "imageUrl must be an http(s) address or a path starting with /.")]);
    page.type("imageUrl", "javascript:x");
    mock.timers.tick(1500);
    await settle();
    assert.equal(page.status.dataset.state, "error");
    assert.match(page.status.textContent, /^Not saved: imageUrl must be/);
    mock.timers.tick(60000);
    assert.equal(page.requests.length, 1);

    page.type("imageUrl", "/a.png");
    mock.timers.tick(1500);
    assert.equal(page.requests.length, 2);
  });

  test("hiding the page sends pending changes at once with keepalive", () => {
    const page = loadPage();
    page.type("content", "Just typed");
    page.document.visibilityState = "hidden";
    page.fire("document", "visibilitychange");
    assert.equal(page.requests.length, 1);
    assert.equal(page.requests[0].keepalive, true);
    assert.deepEqual(page.requests[0].body, { content: "Just typed" });
    mock.timers.tick(5000);
    assert.equal(page.requests.length, 1);
  });

  test("pagehide sends pending changes with keepalive, even while another save is running", () => {
    const page = loadPage([new Promise(() => {})]);
    page.type("title", "One");
    mock.timers.tick(1500);
    page.type("title", "Two");
    page.fire("window", "pagehide");
    assert.equal(page.requests.length, 2);
    assert.equal(page.requests[1].keepalive, true);
    assert.deepEqual(page.requests[1].body, { title: "Two" });
  });

  test("nothing is sent on exit when there are no changes", () => {
    const page = loadPage();
    page.document.visibilityState = "hidden";
    page.fire("document", "visibilitychange");
    page.fire("window", "pagehide");
    assert.equal(page.requests.length, 0);
  });

  test("a body over the keepalive limit is sent without keepalive", () => {
    const page = loadPage();
    page.type("content", "א".repeat(40000)); // 80000 bytes in UTF-8
    page.fire("window", "pagehide");
    assert.equal(page.requests[0].keepalive, false);
  });

  test("beforeunload warns only when changes could not be sent", async () => {
    const page = loadPage([offline]);
    assert.equal(page.fire("window", "beforeunload", beforeUnloadEvent()).prevented, false);

    page.type("title", "Sent on leave");
    const leaving = page.fire("window", "beforeunload", beforeUnloadEvent());
    assert.equal(page.requests.length, 1, "changes are sent first");
    assert.equal(leaving.prevented, false);
    await settle(); // that save failed: offline

    page.type("title", "Sent while offline");
    assert.equal(page.fire("window", "beforeunload", beforeUnloadEvent()).prevented, true);
  });

  test("coming back online retries at once", async () => {
    const page = loadPage([offline]);
    page.type("title", "x");
    mock.timers.tick(1500);
    await settle();
    page.fire("window", "online");
    assert.equal(page.requests.length, 2);
  });
});
