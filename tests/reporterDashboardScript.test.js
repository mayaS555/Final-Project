// Tests for public/js/reporter-dashboard.js (owned by B): "New article", "Edit published article", "Delete" and
// removing ?msg= from the address. The real script runs in a vm context with a small fake dashboard
// (rows, buttons, confirm, location, history) and a fake fetch, so no browser is needed.
// Run: node --test tests/

const { describe, test } = require("node:test");
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SCRIPT = fs.readFileSync(
  path.join(__dirname, "..", "public", "js", "reporter-dashboard.js"),
  "utf8",
);

/**
 * Lets pending promises finish.
 * @returns {Promise<void>}
 * @example await settle();
 */
async function settle() {
  for (let round = 0; round < 5; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * A fetch-like response.
 * @param {number} status The HTTP status.
 * @param {Object} [body] The JSON body.
 * @returns {Promise<Object>} The response.
 * @example answer(201, { id: "new1" })
 */
function answer(status, body = {}) {
  return Promise.resolve({ ok: status < 400, status, json: async () => body });
}

/**
 * A fake button: a disabled button gets no click, like in a browser.
 * @param {string} [action] Its data-action ("revise" or "delete"), or none for "New article".
 * @returns {Object} The button.
 * @example const button = fakeButton("delete");
 */
function fakeButton(action) {
  const listeners = [];
  return {
    dataset: action ? { action } : {},
    disabled: true,
    row: null,
    addEventListener(type, handler) {
      listeners.push(handler);
    },
    closest(selector) {
      return selector === ".rep-row" ? this.row : this;
    },
    click(list) {
      if (this.disabled) {
        return;
      }
      for (const handler of listeners) {
        handler({});
      }
      if (list) {
        list.fireClick(this);
      }
    },
  };
}

/**
 * Loads the script into a fake dashboard.
 * @param {Object} options
 * @param {Array<Promise|Function>} [options.answers] Answers for the next fetch calls, in order.
 * @param {string[]} [options.rows] Ids of the rows; each row has a revise and a delete button.
 * @param {string} [options.href] The page address.
 * @param {boolean} [options.confirmAnswer] What confirm() answers.
 * @returns {Object} { requests, rows, list, newArticleButton, statusLine, emptyMessage, window, history }.
 * @example const page = loadDashboard({ rows: ["a1"] });
 */
function loadDashboard({
  answers = [],
  rows = ["a1"],
  href = "http://localhost/reporter",
  confirmAnswer = true,
} = {}) {
  const clickListeners = [];
  const list = {
    children: [],
    addEventListener(type, handler) {
      clickListeners.push(handler);
    },
    querySelectorAll() {
      return list.children.flatMap((row) => [
        row.reviseButton,
        row.deleteButton,
      ]);
    },
    fireClick(button) {
      for (const handler of clickListeners) {
        handler({ target: button });
      }
    },
  };
  for (const id of rows) {
    const row = {
      dataset: { articleId: id, editUrl: `/reporter/articles/${id}/edit` },
      reviseButton: fakeButton("revise"),
      deleteButton: fakeButton("delete"),
      querySelector(selector) {
        return selector === ".rep-row-title"
          ? { textContent: `Title ${id}` }
          : row.deleteButton;
      },
      remove() {
        list.children.splice(list.children.indexOf(row), 1);
      },
    };
    row.reviseButton.row = row;
    row.deleteButton.row = row;
    list.children.push(row);
  }

  const statusLine = {
    textContent: "",
    hasErrorClass: false,
    classList: { toggle: (name, on) => (statusLine.hasErrorClass = on) },
  };
  const emptyMessage = { hidden: true };
  const newArticleButton = fakeButton();
  const elements = {
    "rep-new-article": newArticleButton,
    "rep-list": list,
    "rep-empty": emptyMessage,
    "rep-status": statusLine,
  };
  const history = { calls: [] };
  history.replaceState = (state, title, url) => history.calls.push(String(url));
  const window = {
    location: { href },
    history,
    confirmCalls: 0,
    confirm() {
      window.confirmCalls += 1;
      return confirmAnswer;
    },
  };
  const requests = [];
  /**
   * Stands in for fetch: records the request and returns the next prepared answer.
   * @param {string} url The requested address.
   * @param {Object} options The fetch options.
   * @returns {Promise<Object>} The next answer, or a 200 answer when none is left.
   * @example Passed to the script as its global fetch.
   */
  const fakeFetch = (url, options) => {
    requests.push({ url, method: options.method, headers: options.headers });
    const next = answers.shift();
    return typeof next === "function" ? next() : next || answer(200);
  };

  vm.runInContext(
    SCRIPT,
    vm.createContext({
      document: { getElementById: (id) => elements[id] },
      window,
      fetch: fakeFetch,
      URL,
    }),
  );
  return {
    requests,
    rows: list.children.slice(),
    list,
    newArticleButton,
    statusLine,
    emptyMessage,
    window,
    history,
  };
}

describe("reporter dashboard script", () => {
  test("enables the buttons once loaded", () => {
    const page = loadDashboard({ rows: ["a1", "a2"] });
    assert.equal(page.newArticleButton.disabled, false);
    assert.ok(
      page.rows.every(
        (row) => !row.reviseButton.disabled && !row.deleteButton.disabled,
      ),
    );
  });

  test("New article creates a draft and opens its edit page", async () => {
    const page = loadDashboard({ answers: [answer(201, { id: "new1" })] });
    page.newArticleButton.click();
    assert.equal(page.newArticleButton.disabled, true);
    await settle();
    assert.deepEqual(page.requests, [
      {
        url: "/api/articles",
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
    ]);
    assert.equal(page.window.location.href, "/reporter/articles/new1/edit");
  });

  test("Edit published article calls revise, then opens the edit page; disabled while it runs", async () => {
    let finish;
    const page = loadDashboard({
      answers: [() => new Promise((resolve) => (finish = resolve))],
    });
    const button = page.rows[0].reviseButton;
    button.click(page.list);
    assert.equal(button.disabled, true);
    button.click(page.list);
    assert.equal(page.requests.length, 1, "a second click sends nothing");
    assert.deepEqual(page.requests[0], {
      url: "/api/articles/a1/revise",
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    finish({ ok: true, status: 200, json: async () => ({}) });
    await settle();
    assert.equal(page.window.location.href, "/reporter/articles/a1/edit");
  });

  test("a failed revise shows the server's message and enables the button again", async () => {
    const page = loadDashboard({
      answers: [
        answer(409, { error: "An article cannot go from draft to draft." }),
      ],
    });
    page.rows[0].reviseButton.click(page.list);
    await settle();
    assert.equal(
      page.statusLine.textContent,
      "An article cannot go from draft to draft.",
    );
    assert.equal(page.statusLine.hasErrorClass, true);
    assert.equal(page.rows[0].reviseButton.disabled, false);
    assert.equal(page.window.location.href, "http://localhost/reporter");
  });

  test("Delete asks first; Cancel sends nothing and keeps the row", async () => {
    const page = loadDashboard({ confirmAnswer: false });
    page.rows[0].deleteButton.click(page.list);
    await settle();
    assert.equal(page.window.confirmCalls, 1);
    assert.equal(page.requests.length, 0);
    assert.equal(page.list.children.length, 1);
    assert.equal(page.rows[0].deleteButton.disabled, false);
  });

  test("Delete removes the row without reloading; the empty message shows after the last one", async () => {
    const page = loadDashboard({
      rows: ["a1", "a2"],
      answers: [answer(204), answer(204)],
    });
    page.rows[0].deleteButton.click(page.list);
    await settle();
    assert.deepEqual(page.requests[0], {
      url: "/api/articles/a1",
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(page.list.children.length, 1);
    assert.equal(page.emptyMessage.hidden, true);
    assert.equal(page.statusLine.textContent, "Article deleted.");

    page.rows[1].deleteButton.click(page.list);
    await settle();
    assert.equal(page.list.children.length, 0);
    assert.equal(page.emptyMessage.hidden, false);
    assert.equal(
      page.window.location.href,
      "http://localhost/reporter",
      "no reload",
    );
  });

  test("a failed delete keeps the row and shows the message", async () => {
    const page = loadDashboard({
      answers: [answer(403, { error: "You cannot delete this article." })],
    });
    page.rows[0].deleteButton.click(page.list);
    await settle();
    assert.equal(page.list.children.length, 1);
    assert.equal(
      page.statusLine.textContent,
      "You cannot delete this article.",
    );
    assert.equal(page.rows[0].deleteButton.disabled, false);
  });

  test("removes ?msg= from the address, keeping other parameters", () => {
    const page = loadDashboard({
      href: "http://localhost/reporter?status=pending&msg=submitted",
    });
    assert.deepEqual(page.history.calls, [
      "http://localhost/reporter?status=pending",
    ]);
    assert.deepEqual(loadDashboard().history.calls, []);
  });
});
