// A small fake of the edit page for testing the browser scripts in Node (owned by B). The real scripts
// (reporter-autosave.js, and reporter-edit.js when asked) run in one vm context, like classic scripts on one page,
// with fake elements, a fake fetch that records every request, and the test's (mockable) setTimeout.
// Used by tests/reporterAutosave.test.js and tests/reporterEditSubmit.test.js.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SCRIPT_FOLDER = path.join(__dirname, "..", "public", "js");
const FIELDS = [
  { name: "title", id: "rep-title", label: "Title" },
  { name: "summary", id: "rep-summary", label: "Summary" },
  { name: "content", id: "rep-content", label: "Article text" },
  { name: "imageUrl", id: "rep-image", label: "Image address" },
  { name: "category", id: "rep-category", label: "Category" },
];

/**
 * A successful answer (PATCH or submit).
 * @param {string} [savedAt] The savedAt the server sends back.
 * @returns {Promise<Object>} A fetch-like response.
 * @example loadEditPage([saved]);
 */
function saved(savedAt = "2026-10-18T09:30:00.000Z") {
  return Promise.resolve({ ok: true, status: 200, json: async () => ({ savedAt }) });
}

/**
 * A failed answer.
 * @param {number} status The HTTP status.
 * @param {string} [error] The error message in the body.
 * @returns {Promise<Object>} A fetch-like response.
 * @example loadEditPage([failed(409)]);
 */
function failed(status, error = "Something is wrong.") {
  return Promise.resolve({ ok: false, status, json: async () => ({ error }) });
}

/**
 * A network failure (fetch rejects). Pass the function itself, so the rejection is created only when fetch asks.
 * @returns {Promise<never>} A rejected promise.
 * @example loadEditPage([offline, saved]);
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

/**
 * A fake element with the few things the scripts use: text, dataset, a class toggle and attributes.
 * @param {Object} [properties] Extra properties.
 * @returns {Object} The element.
 * @example const status = fakeElement();
 */
function fakeElement(properties = {}) {
  const element = {
    textContent: "",
    dataset: {},
    attributes: {},
    hasErrorClass: false,
    classList: {
      toggle(className, on) {
        element.hasErrorClass = on;
      },
    },
    setAttribute(name, value) {
      element.attributes[name] = String(value);
    },
    removeAttribute(name) {
      delete element.attributes[name];
    },
    ...properties,
  };
  return element;
}

/**
 * Loads the edit page scripts into a fake page.
 * @param {Array<Promise|Function>} [fetchAnswers] Answers for the next fetch calls, in order. A function is called
 *   to create the answer (for answers resolved later, or rejections). Without answers, fetch answers "saved".
 * @param {{ withSubmit?: boolean, status?: string }} [options] withSubmit also loads reporter-edit.js with a submit
 *   button; status is the article status in the form's data-status.
 * @returns {Object} { requests, status, formMessage, submitButton, fieldset, fields, document, window, context,
 *   type, fire, focused }.
 * @example const page = loadEditPage([saved], { withSubmit: true });
 */
function loadEditPage(fetchAnswers = [], { withSubmit = false, status = "draft" } = {}) {
  const listeners = { form: {}, document: {}, window: {}, submit: {} };
  const eventTarget = (owner) => ({
    addEventListener(type, handler) {
      (listeners[owner][type] = listeners[owner][type] || []).push(handler);
    },
  });
  const page = { focused: null };

  const fields = {};
  const labels = {};
  for (const { name, id, label } of FIELDS) {
    fields[name] = fakeElement({
      name,
      id,
      value: "",
      focus() {
        page.focused = name;
      },
    });
    labels[id] = fakeElement({ textContent: label });
  }
  const fieldset = { disabled: false };
  const form = {
    ...eventTarget("form"),
    dataset: { articleId: "a1", status, requiredFields: "title,content,category" },
    elements: fields,
    querySelector(selector) {
      if (selector === ".rep-fields") {
        return fieldset;
      }
      const label = /^label\[for="(.+)"\]$/.exec(selector);
      return label ? labels[label[1]] : null;
    },
  };
  const statusElement = fakeElement();
  const formMessage = fakeElement();
  const submitButton = { ...eventTarget("submit"), disabled: true };
  const elements = {
    "rep-edit-form": form,
    "rep-save-status": statusElement,
    "rep-edit-status": formMessage,
    "rep-submit": submitButton,
  };
  const document = { ...eventTarget("document"), visibilityState: "visible", getElementById: (id) => elements[id] };
  const window = { ...eventTarget("window"), location: { href: "/reporter/articles/a1/edit" } };
  const requests = [];

  const fakeFetch = (url, options) => {
    requests.push({
      url,
      method: options.method,
      keepalive: options.keepalive,
      body: options.body === undefined ? undefined : JSON.parse(options.body),
      headers: options.headers,
    });
    const answer = fetchAnswers.shift();
    if (answer === undefined) {
      return saved();
    }
    return typeof answer === "function" ? answer() : answer;
  };

  const context = vm.createContext({ document, window, fetch: fakeFetch, setTimeout, clearTimeout, Blob, Date });
  vm.runInContext(fs.readFileSync(path.join(SCRIPT_FOLDER, "reporter-autosave.js"), "utf8"), context);
  if (withSubmit) {
    vm.runInContext(fs.readFileSync(path.join(SCRIPT_FOLDER, "reporter-edit.js"), "utf8"), context);
  }

  /**
   * Fires an event on the form, the document, the window or the submit button.
   * @param {string} owner "form", "document", "window" or "submit".
   * @param {string} type The event type.
   * @param {Object} [event] The event object.
   * @returns {Object} The event object (to check preventDefault).
   */
  function fire(owner, type, event = {}) {
    // Like a browser: a disabled button gets no click.
    if (owner === "submit" && submitButton.disabled) {
      return event;
    }
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

  return Object.assign(page, {
    requests,
    status: statusElement,
    formMessage,
    submitButton,
    fieldset,
    fields,
    document,
    window,
    context,
    type,
    fire,
  });
}

module.exports = { loadEditPage, saved, failed, offline, settle, beforeUnloadEvent };
