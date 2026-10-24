// Tests for public/js/reporter-autosave.js (owned by B). The real script runs in the fake page from
// tests/fakeEditPage.js with Node's mock timers, so no browser is needed.
// Run: node --test tests/

const { describe, test, beforeEach, afterEach, mock } = require("node:test");
const assert = require("assert");
const {
  loadEditPage,
  saved,
  failed,
  offline,
  settle,
  beforeUnloadEvent,
} = require("./fakeEditPage");

describe("reporter autosave", () => {
  beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
  afterEach(() => mock.timers.reset());

  test("saves once, 1.5 seconds after the last change", async () => {
    const page = loadEditPage();
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
    const page = loadEditPage();
    page.type("title", "Storm");
    mock.timers.tick(1500);
    await settle();
    page.type("summary", "Short");
    page.type("category", "Sports");
    mock.timers.tick(1500);
    assert.deepEqual(page.requests[1].body, {
      summary: "Short",
      category: "Sports",
    });
  });

  test("ignores input from elements that are not article fields", () => {
    const page = loadEditPage();
    page.fire("form", "input", { target: { name: "search", value: "x" } });
    mock.timers.tick(5000);
    assert.equal(page.requests.length, 0);
  });

  test("never runs two saves at once; changes made meanwhile are sent right after", async () => {
    let finishFirst;
    const page = loadEditPage([
      () => new Promise((resolve) => (finishFirst = resolve)),
    ]);
    page.type("title", "First");
    mock.timers.tick(1500);
    page.type("content", "Typed during the save");
    mock.timers.tick(1500);
    assert.equal(page.requests.length, 1);

    finishFirst({
      ok: true,
      status: 200,
      json: async () => ({ savedAt: "2026-10-18T09:30:00.000Z" }),
    });
    await settle();
    assert.equal(page.requests.length, 2);
    assert.deepEqual(page.requests[1].body, {
      content: "Typed during the save",
    });
  });

  test("offline: keeps the data, shows the offline state and retries with growing waits", async () => {
    const page = loadEditPage([offline, offline, saved]);
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
    const page = loadEditPage([failed(500)]);
    page.type("title", "Kept");
    mock.timers.tick(1500);
    await settle();
    assert.equal(page.status.dataset.state, "offline");
    mock.timers.tick(2000);
    assert.equal(page.requests.length, 2);
  });

  for (const status of [403, 409]) {
    test(`${status}: stops autosaving, locks the fields and asks to reload`, async () => {
      const page = loadEditPage([failed(status)]);
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
      assert.equal(
        page.fire("window", "beforeunload", beforeUnloadEvent()).prevented,
        true,
      );
    });
  }

  test("401: stops and says the user is no longer logged in", async () => {
    const page = loadEditPage([failed(401)]);
    page.type("title", "x");
    mock.timers.tick(1500);
    await settle();
    assert.equal(page.status.dataset.state, "stopped");
    assert.match(page.status.textContent, /no longer logged in/);
  });

  test("400: shows the server's message and waits for the next change instead of retrying", async () => {
    const page = loadEditPage([
      failed(
        400,
        "imageUrl must be an http(s) address or a path starting with /.",
      ),
    ]);
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
    const page = loadEditPage();
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
    const page = loadEditPage([new Promise(() => {})]);
    page.type("title", "One");
    mock.timers.tick(1500);
    page.type("title", "Two");
    page.fire("window", "pagehide");
    assert.equal(page.requests.length, 2);
    assert.equal(page.requests[1].keepalive, true);
    assert.deepEqual(page.requests[1].body, { title: "Two" });
  });

  test("nothing is sent on exit when there are no changes", () => {
    const page = loadEditPage();
    page.document.visibilityState = "hidden";
    page.fire("document", "visibilitychange");
    page.fire("window", "pagehide");
    assert.equal(page.requests.length, 0);
  });

  test("a body over the keepalive limit is sent without keepalive", () => {
    const page = loadEditPage();
    page.type("content", "א".repeat(40000)); // 80000 bytes in UTF-8
    page.fire("window", "pagehide");
    assert.equal(page.requests[0].keepalive, false);
  });

  test("beforeunload warns only when changes could not be sent", async () => {
    const page = loadEditPage([offline]);
    assert.equal(
      page.fire("window", "beforeunload", beforeUnloadEvent()).prevented,
      false,
    );

    page.type("title", "Sent on leave");
    const leaving = page.fire("window", "beforeunload", beforeUnloadEvent());
    assert.equal(page.requests.length, 1, "changes are sent first");
    assert.equal(leaving.prevented, false);
    await settle(); // that save failed: offline

    page.type("title", "Sent while offline");
    assert.equal(
      page.fire("window", "beforeunload", beforeUnloadEvent()).prevented,
      true,
    );
  });

  test("coming back online retries at once", async () => {
    const page = loadEditPage([offline]);
    page.type("title", "x");
    mock.timers.tick(1500);
    await settle();
    page.fire("window", "online");
    assert.equal(page.requests.length, 2);
  });
});

describe("saveAllNow (used before submitting)", () => {
  beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
  afterEach(() => mock.timers.reset());

  test("with nothing to save, resolves true without a request", async () => {
    const page = loadEditPage();
    assert.equal(await page.context.saveAllNow(), true);
    assert.equal(page.requests.length, 0);
  });

  test("sends pending changes at once, without waiting for the typing delay", async () => {
    const page = loadEditPage();
    page.type("title", "Just typed");
    assert.equal(await page.context.saveAllNow(), true);
    assert.deepEqual(
      page.requests.map((request) => request.body),
      [{ title: "Just typed" }],
    );
    mock.timers.tick(5000);
    assert.equal(page.requests.length, 1);
  });

  test("waits for a running save, then saves what was typed meanwhile", async () => {
    let finishFirst;
    const page = loadEditPage([
      () => new Promise((resolve) => (finishFirst = resolve)),
    ]);
    page.type("title", "First");
    mock.timers.tick(1500);
    page.type("content", "Meanwhile");

    let done = false;
    const result = page.context.saveAllNow().then((value) => {
      done = true;
      return value;
    });
    await settle();
    assert.equal(done, false, "still waiting for the first save");

    finishFirst({
      ok: true,
      status: 200,
      json: async () => ({ savedAt: "2026-10-18T09:30:00.000Z" }),
    });
    assert.equal(await result, true);
    assert.deepEqual(
      page.requests.map((request) => request.body),
      [{ title: "First" }, { content: "Meanwhile" }],
    );
  });

  test("resolves false when the save fails, and keeps the change as unsaved", async () => {
    const page = loadEditPage([offline]);
    page.type("title", "x");
    assert.equal(await page.context.saveAllNow(), false);
    assert.equal(page.status.dataset.state, "offline");
    // Still offline: the save sent on leaving will probably fail too, so the browser asks.
    assert.equal(
      page.fire("window", "beforeunload", beforeUnloadEvent()).prevented,
      true,
    );
  });

  test("resolves false when autosave has stopped", async () => {
    const page = loadEditPage([failed(409)]);
    page.type("title", "x");
    mock.timers.tick(1500);
    await settle();
    assert.equal(await page.context.saveAllNow(), false);
    assert.equal(page.requests.length, 1);
  });
});
