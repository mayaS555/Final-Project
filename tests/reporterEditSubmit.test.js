// Tests for public/js/reporter-edit.js, the "Submit for approval" / "Resubmit" button (owned by B). It runs with
// reporter-autosave.js in the fake page from tests/fakeEditPage.js, so no browser is needed.
// Run: node --test tests/

const { describe, test, beforeEach, afterEach, mock } = require("node:test");
const assert = require("assert");
const { loadEditPage, saved, failed, offline, settle } = require("./fakeEditPage");

/**
 * Fills the required fields, so a submit can pass.
 * @param {Object} page The fake page.
 * @returns {void}
 * @example fillRequired(page);
 */
function fillRequired(page) {
  page.type("title", "Harbor report");
  page.type("content", "Text");
  page.type("category", "Sports");
}

/**
 * Clicks Submit and lets the requests and answers finish.
 * @param {Object} page The fake page.
 * @returns {Promise<void>}
 * @example await clickSubmit(page);
 */
async function clickSubmit(page) {
  page.fire("submit", "click");
  for (let round = 0; round < 5; round += 1) {
    await settle();
  }
}

describe("reporter submit button", () => {
  beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
  afterEach(() => mock.timers.reset());

  test("is enabled once the script has loaded", () => {
    assert.equal(loadEditPage([], { withSubmit: true }).submitButton.disabled, false);
  });

  test("saves the latest changes first, then submits and opens the dashboard with a message", async () => {
    const page = loadEditPage([saved, saved], { withSubmit: true });
    fillRequired(page);
    await clickSubmit(page);

    assert.deepEqual(
      page.requests.map((request) => `${request.method} ${request.url}`),
      ["PATCH /api/articles/a1", "POST /api/articles/a1/submit"]
    );
    assert.deepEqual(page.requests[0].body, { title: "Harbor report", content: "Text", category: "Sports" });
    assert.deepEqual(page.requests[1].headers, { "Content-Type": "application/json" });
    assert.equal(page.window.location.href, "/reporter?msg=submitted");
  });

  test("a returned article opens the dashboard with the resubmitted message", async () => {
    const page = loadEditPage([saved], { withSubmit: true, status: "returned" });
    await clickSubmit(page);
    assert.equal(page.window.location.href, "/reporter?msg=resubmitted");
  });

  test("the button and the fields are disabled while it runs, so a second click sends nothing", async () => {
    let finishSubmit;
    const page = loadEditPage([() => new Promise((resolve) => (finishSubmit = resolve))], { withSubmit: true });
    page.fire("submit", "click");
    await settle();
    assert.equal(page.submitButton.disabled, true);
    assert.equal(page.fieldset.disabled, true);
    page.fire("submit", "click");
    await settle();
    assert.equal(page.requests.filter((request) => request.url.endsWith("/submit")).length, 1);
    finishSubmit({ ok: true, status: 200, json: async () => ({}) });
  });

  test("400: names the empty fields by their labels, marks them and focuses the first", async () => {
    const page = loadEditPage([failed(400, "Please fill in: title, category.")], { withSubmit: true });
    page.fields.content.value = "Some text";
    await clickSubmit(page);

    assert.equal(page.formMessage.textContent, "Please fill in: Title, Category.");
    assert.equal(page.formMessage.hasErrorClass, true);
    assert.equal(page.fields.title.attributes["aria-invalid"], "true");
    assert.equal(page.fields.category.attributes["aria-invalid"], "true");
    assert.equal(page.fields.content.attributes["aria-invalid"], undefined);
    assert.equal(page.focused, "title");
    assert.deepEqual([page.submitButton.disabled, page.fieldset.disabled], [false, false]);
    assert.equal(page.window.location.href, "/reporter/articles/a1/edit");

    page.type("title", "Now filled");
    assert.equal(page.fields.title.attributes["aria-invalid"], undefined);
  });

  test("409: shows the server's message, asks to reload and keeps the form locked", async () => {
    const page = loadEditPage([failed(409, "An article cannot go from pending to pending.")], { withSubmit: true });
    await clickSubmit(page);
    assert.equal(
      page.formMessage.textContent,
      "An article cannot go from pending to pending. Reload the page to see its current state."
    );
    assert.equal(page.formMessage.hasErrorClass, true);
    assert.deepEqual([page.submitButton.disabled, page.fieldset.disabled], [true, true]);
  });

  test("does not submit when the latest changes cannot be saved", async () => {
    const page = loadEditPage([offline], { withSubmit: true });
    fillRequired(page);
    await clickSubmit(page);
    assert.deepEqual(page.requests.map((request) => request.method), ["PATCH"]);
    assert.match(page.formMessage.textContent, /not saved, so the article was not sent/);
    assert.deepEqual([page.submitButton.disabled, page.fieldset.disabled], [false, false]);
  });

  test("a network failure on submit shows a message and unlocks the form", async () => {
    const page = loadEditPage([offline], { withSubmit: true });
    await clickSubmit(page);
    assert.match(page.formMessage.textContent, /Could not reach the server/);
    assert.equal(page.submitButton.disabled, false);
  });
});
