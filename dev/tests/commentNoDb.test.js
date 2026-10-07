// DEVELOPMENT ONLY. Comment checks that need no MongoDB: the rate limiter with a fake clock,
// input validation, JSON error handling and template escaping. The database-backed comment checks
// (CRUD, ownership, pagination, quota over HTTP) are in publicDb.test.js.
// Run with: node --test dev/tests/commentNoDb.test.js

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const ejs = require("ejs");
const createDevApp = require("../createDevApp");
const { createCommentRateLimiter } = require("../../services/commentRateLimiter");
const { parseDisplayName, parseCommentBody, MAX_NAME_LENGTH, MAX_BODY_LENGTH } = require("../../controllers/commentController");
const { parseCursor } = require("../../services/commentService");

const viewsDir = path.join(__dirname, "..", "..", "views", "public");

describe("comment rate limiter (fake clock)", () => {
  function createLimiter() {
    const clock = { time: 1_000_000 };
    const limiter = createCommentRateLimiter({ limit: 3, windowMs: 60_000, now: () => clock.time });
    return { clock, limiter };
  }

  it("allows the first three comments and rejects the fourth with a retry time", () => {
    const { limiter } = createLimiter();
    for (let count = 0; count < 3; count += 1) {
      assert.strictEqual(limiter.reserve("device-a").allowed, true);
    }
    const fourth = limiter.reserve("device-a");
    assert.strictEqual(fourth.allowed, false);
    assert.strictEqual(fourth.retryAfterSeconds, 60);
  });

  it("rejected attempts are not counted and do not extend the wait", () => {
    const { clock, limiter } = createLimiter();
    for (let count = 0; count < 3; count += 1) {
      limiter.reserve("device-a");
    }
    clock.time += 20_000;
    for (let count = 0; count < 10; count += 1) {
      assert.strictEqual(limiter.reserve("device-a").allowed, false);
    }
    assert.strictEqual(limiter.reserve("device-a").retryAfterSeconds, 40);
    clock.time += 40_000;
    assert.strictEqual(limiter.reserve("device-a").allowed, true);
  });

  it("the window is rolling: slots come back one by one as the oldest ones expire", () => {
    const { clock, limiter } = createLimiter();
    limiter.reserve("device-a");
    clock.time += 10_000;
    limiter.reserve("device-a");
    clock.time += 10_000;
    limiter.reserve("device-a");

    clock.time += 39_999;
    assert.strictEqual(limiter.reserve("device-a").allowed, false, "the first reservation is 59.999 s old");
    clock.time += 1;
    assert.strictEqual(limiter.reserve("device-a").allowed, true, "the first reservation has expired at 60 s");
    assert.strictEqual(limiter.reserve("device-a").allowed, false, "the other two are still inside the window");
    clock.time += 10_000;
    assert.strictEqual(limiter.reserve("device-a").allowed, true, "the second reservation expired");
  });

  it("the quota is not reset by a clock minute boundary", () => {
    const { clock, limiter } = createLimiter();
    clock.time = 59_000;
    for (let count = 0; count < 3; count += 1) {
      limiter.reserve("device-a");
    }
    clock.time = 61_000;
    assert.strictEqual(limiter.reserve("device-a").allowed, false);
  });

  it("devices have independent quotas", () => {
    const { limiter } = createLimiter();
    for (let count = 0; count < 3; count += 1) {
      limiter.reserve("device-a");
    }
    assert.strictEqual(limiter.reserve("device-a").allowed, false);
    for (let count = 0; count < 3; count += 1) {
      assert.strictEqual(limiter.reserve("device-b").allowed, true);
    }
  });

  it("simultaneous reservations cannot pass more than the limit", () => {
    const { limiter } = createLimiter();
    const results = Array.from({ length: 25 }, () => limiter.reserve("device-a"));
    assert.strictEqual(results.filter((result) => result.allowed).length, 3);
  });

  it("releasing a reservation gives back exactly that slot, once", () => {
    const { limiter } = createLimiter();
    const first = limiter.reserve("device-a");
    limiter.reserve("device-a");
    limiter.reserve("device-a");
    assert.strictEqual(limiter.reserve("device-a").allowed, false);

    first.release();
    first.release();
    assert.strictEqual(limiter.reserve("device-a").allowed, true);
    assert.strictEqual(limiter.reserve("device-a").allowed, false, "a second release did not free another slot");
  });

  it("releasing one of two reservations made at the same millisecond keeps the other", () => {
    const { limiter } = createLimiter();
    const first = limiter.reserve("device-a");
    limiter.reserve("device-a");
    first.release();
    assert.strictEqual(limiter.reserve("device-a").allowed, true);
    assert.strictEqual(limiter.reserve("device-a").allowed, true);
    assert.strictEqual(limiter.reserve("device-a").allowed, false);
  });

  it("a late release after the window does not remove a newer reservation", () => {
    const { clock, limiter } = createLimiter();
    const old = limiter.reserve("device-a");
    clock.time += 61_000;
    for (let count = 0; count < 3; count += 1) {
      limiter.reserve("device-a");
    }
    old.release();
    assert.strictEqual(limiter.reserve("device-a").allowed, false);
  });

  it("forgets inactive devices after the window", () => {
    const { clock, limiter } = createLimiter();
    for (let index = 0; index < 50; index += 1) {
      limiter.reserve(`device-${index}`);
    }
    assert.strictEqual(limiter.trackedDeviceCount(), 50);

    clock.time += 61_000;
    limiter.reserve("someone-new");
    assert.strictEqual(limiter.trackedDeviceCount(), 1);
  });

  it("a device with no live reservations is removed when its last reservation is released", () => {
    const { limiter } = createLimiter();
    const slot = limiter.reserve("device-a");
    assert.strictEqual(limiter.trackedDeviceCount(), 1);
    slot.release();
    assert.strictEqual(limiter.trackedDeviceCount(), 0);
  });
});

describe("comment field validation", () => {
  it("trims the name and rejects empty, long, non-text and control characters", () => {
    assert.deepStrictEqual(parseDisplayName("  Dana  "), { value: "Dana" });
    assert.deepStrictEqual(parseDisplayName("x".repeat(MAX_NAME_LENGTH)), { value: "x".repeat(MAX_NAME_LENGTH) });
    for (const bad of ["", "   ", "x".repeat(MAX_NAME_LENGTH + 1), "a\nb", "a\u0000b", "a\tb", 5, null, undefined, ["a"], { a: 1 }]) {
      assert.ok(parseDisplayName(bad).error, JSON.stringify(bad));
    }
  });

  it("trims the body, keeps inner line breaks and rejects empty, long, non-text and control characters", () => {
    assert.deepStrictEqual(parseCommentBody("  hello\r\nworld  "), { value: "hello\nworld" });
    assert.deepStrictEqual(parseCommentBody("a\tb\nc"), { value: "a\tb\nc" });
    assert.deepStrictEqual(parseCommentBody("x".repeat(MAX_BODY_LENGTH)), { value: "x".repeat(MAX_BODY_LENGTH) });
    for (const bad of ["", "  \n ", "x".repeat(MAX_BODY_LENGTH + 1), "a\u0000b", "a\u0007b", 5, null, undefined, ["a"], { a: 1 }]) {
      assert.ok(parseCommentBody(bad).error, JSON.stringify(bad));
    }
  });

  it("only well-formed cursors are accepted", () => {
    const id = "64b7f0f2a1b2c3d4e5f60718";
    assert.deepStrictEqual(parseCursor(`1700000000000_${id}`), { createdAt: new Date(1700000000000), id });
    for (const bad of ["", "abc", `_${id}`, "1700000000000_zzz", `1700000000000_${id.toUpperCase()}`, `1700000000000_${id}x`, `-5_${id}`, `${"9".repeat(16)}_${id}`, undefined, ["a"], { $ne: 1 }]) {
      assert.strictEqual(parseCursor(bad), null, JSON.stringify(bad));
    }
  });
});

describe("comment routes without a database", () => {
  let server;
  let baseUrl;
  const originalConsoleError = console.error;
  const articleId = "64b7f0f2a1b2c3d4e5f60718";
  const commentId = "64b7f0f2a1b2c3d4e5f60719";

  before(async () => {
    // No article model is connected on purpose.
    server = createDevApp().listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    console.error = () => {};
  });

  after(() => {
    console.error = originalConsoleError;
    server.close();
  });

  function send(method, url, { body, contentType = "application/json" } = {}) {
    const options = { method, headers: {} };
    if (body !== undefined) {
      options.headers["Content-Type"] = contentType;
      options.body = typeof body === "string" ? body : JSON.stringify(body);
    }
    return fetch(baseUrl + url, options);
  }

  const commentsUrl = `/api/public/articles/${articleId}/comments`;

  it("POST rejects invalid input with 400 and a JSON message, before touching the database", async () => {
    const cases = {
      "an array": { body: [] },
      "a JSON string": { body: '"text"' },
      "a missing name": { body: { body: "hello" } },
      "a name that is not text": { body: { displayName: 5, body: "hello" } },
      "a blank name": { body: { displayName: "  ", body: "hello" } },
      "a long name": { body: { displayName: "x".repeat(41), body: "hello" } },
      "a missing comment": { body: { displayName: "Dana" } },
      "a blank comment": { body: { displayName: "Dana", body: " \n " } },
      "a comment that is not text": { body: { displayName: "Dana", body: { $ne: 1 } } },
      "a long comment": { body: { displayName: "Dana", body: "x".repeat(1001) } },
      "a control character": { body: { displayName: "Dana", body: "a\u0000b" } },
    };
    for (const [label, input] of Object.entries(cases)) {
      const response = await send("POST", commentsUrl, input);
      assert.strictEqual(response.status, 400, label);
      assert.match(response.headers.get("content-type"), /application\/json/, label);
      assert.strictEqual(typeof (await response.json()).error, "string", label);
    }
  });

  it("malformed JSON gives a JSON 400 and an oversized body gives 413", async () => {
    for (const method of ["POST", "PATCH"]) {
      const url = method === "POST" ? commentsUrl : `/api/public/comments/${commentId}`;
      const malformed = await send(method, url, { body: '{"displayName": ' });
      assert.strictEqual(malformed.status, 400, method);
      assert.match(malformed.headers.get("content-type"), /application\/json/);
      assert.ok(!(await malformed.text()).includes("SyntaxError"));

      const huge = await send(method, url, { body: { displayName: "Dana", body: "x".repeat(20000) } });
      assert.strictEqual(huge.status, 413, method);
    }
  });

  it("PATCH rejects invalid input with 400", async () => {
    const url = `/api/public/comments/${commentId}`;
    for (const body of [{}, { body: "" }, { body: 5 }, { body: "x".repeat(1001) }, []]) {
      assert.strictEqual((await send("PATCH", url, { body })).status, 400, JSON.stringify(body));
    }
    assert.strictEqual((await send("PATCH", url, { contentType: "text/plain", body: "body=a" })).status, 415);
  });

  it("malformed comment ids give 404 for update and delete", async () => {
    for (const id of ["not-an-id", "123", "zzzzzzzzzzzzzzzzzzzzzzzz"]) {
      assert.strictEqual((await send("PATCH", `/api/public/comments/${id}`, { body: { body: "hello" } })).status, 404, id);
      assert.strictEqual((await send("DELETE", `/api/public/comments/${id}`)).status, 404, id);
    }
  });

  it("a malformed article id gives 404 and never 500", async () => {
    // The 404 comes from the article check, which needs the database; here it ends in the generic 500
    // for a well-formed id and in 404 for a malformed one.
    assert.strictEqual((await send("GET", "/api/public/articles/not-an-id/comments")).status, 404);
    assert.strictEqual((await send("POST", "/api/public/articles/not-an-id/comments", { body: { displayName: "Dana", body: "hello" } })).status, 404);
  });

  it("an invalid or structured cursor gives 400", async () => {
    for (const query of ["before=abc", "before=1_2", "before[$ne]=x", "before[]=a", "before=a&before=b"]) {
      assert.strictEqual((await send("GET", `${commentsUrl}?${query}`)).status, 400, query);
    }
  });

  it("an unexpected failure gives a generic JSON 500", async () => {
    const response = await send("GET", commentsUrl);
    assert.strictEqual(response.status, 500);
    const text = await response.text();
    assert.ok(!text.includes("publicArticleService") && !text.includes("at "));
  });

  it("the comment routes are not mounted for other methods", async () => {
    assert.strictEqual((await send("PUT", `/api/public/comments/${commentId}`, { body: { body: "x" } })).status, 404);
    assert.strictEqual((await send("GET", `/api/public/comments/${commentId}`)).status, 404);
  });
});

describe("article template with comments", () => {
  const article = {
    id: "64b7f0f2a1b2c3d4e5f60718",
    title: "Title",
    summary: "Summary",
    imageUrl: null,
    category: "Tech",
    authorName: "Author",
    publishedAt: "2026-10-01T10:00:00.000Z",
    content: "Body",
  };
  const hostile = '<script>alert(1)</script><img src=x onerror=alert(2)>';

  function comment(overrides = {}) {
    return {
      id: "64b7f0f2a1b2c3d4e5f60800",
      articleId: article.id,
      displayName: hostile,
      body: `${hostile}\nsecond line`,
      createdAt: "2026-10-02T10:00:00.000Z",
      updatedAt: "2026-10-02T10:00:00.000Z",
      canEdit: false,
      canDelete: false,
      ...overrides,
    };
  }

  function render({ items = [], hasMore = false, nextBefore = null, commentsFailed = false } = {}) {
    return ejs.renderFile(path.join(viewsDir, "article.ejs"), {
      pageTitle: article.title,
      article,
      paragraphs: ["Body"],
      comments: { items, hasMore, nextBefore },
      commentsFailed,
      formatDate: () => "October 1, 2026",
      formatDateTime: () => "Oct 2, 2026, 10:00 AM UTC",
    });
  }

  it("escapes the name and the text of a comment", async () => {
    const html = await render({ items: [comment()] });
    assert.ok(!html.includes("<script>alert"));
    assert.ok(!html.includes("<img src=x"));
    assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  });

  it("shows the form, the empty state and no Load more button without comments", async () => {
    const html = await render();
    assert.ok(html.includes('id="pub-comment-form"'));
    assert.ok(html.includes("No comments yet. Be the first to comment."));
    assert.ok(/id="pub-comments-empty"(?![^>]*hidden)/.test(html), "the empty state is visible");
    assert.ok(/id="pub-comments-more" hidden/.test(html));
    assert.ok(html.includes("/js/public-comments.js"));
  });

  it("serves the comment controls disabled, and without a method or action, until the script enables them", async () => {
    const html = await render();
    const formTag = html.match(/<form class="pub-comment-form"[^>]*>/)[0];
    assert.ok(!/\b(action|method)=/.test(formTag), formTag);
    assert.ok(/<fieldset[^>]*id="pub-comment-fields"[^>]*\bdisabled\b/.test(html), "the fieldset starts disabled");
    // Every control sits inside the disabled fieldset, and the no-JavaScript note stays.
    const fieldset = html.slice(html.indexOf('<fieldset class="pub-comment-fields"'), html.indexOf("</fieldset>"));
    for (const id of ["pub-comment-name", "pub-comment-body", "pub-comment-submit"]) {
      assert.ok(fieldset.includes(`id="${id}"`), id);
    }
    assert.ok(html.includes("<noscript>") && html.includes("JavaScript is needed to post comments."));
  });

  it("hides the empty state when comments exist and shows Load more when there are more", async () => {
    const html = await render({ items: [comment()], hasMore: true, nextBefore: "1_64b7f0f2a1b2c3d4e5f60800" });
    assert.ok(/id="pub-comments-empty" hidden/.test(html));
    assert.ok(!/id="pub-comments-more" hidden/.test(html));
    assert.ok(html.includes('data-has-more="true"'));
    assert.ok(html.includes('data-next-before="1_64b7f0f2a1b2c3d4e5f60800"'));
  });

  it("shows Edit and Delete only for comments the viewer may change", async () => {
    const other = await render({ items: [comment()] });
    assert.ok(!other.includes('data-action="edit"') && !other.includes('data-action="delete"'));

    const own = await render({ items: [comment({ canEdit: true, canDelete: true })] });
    assert.ok(own.includes('data-action="edit"') && own.includes('data-action="delete"'));
  });

  it("marks an edited comment and says when comments are unavailable", async () => {
    const edited = await render({ items: [comment({ updatedAt: "2026-10-03T10:00:00.000Z" })] });
    assert.ok(/class="pub-comment-edited">\(edited\)/.test(edited));
    const notEdited = await render({ items: [comment()] });
    assert.ok(/class="pub-comment-edited" hidden>/.test(notEdited));

    const failed = await render({ commentsFailed: true });
    assert.ok(failed.includes("Comments are temporarily unavailable."));
    assert.ok(/id="pub-comments-empty" hidden/.test(failed));
  });
});

describe("comment writes behind express.urlencoded()", () => {
  // The shared server mounts express.urlencoded() before the routes, so a plain HTML form fills req.body.
  // The comment router must reject it by content type, before the controller runs.
  const express = require("express");
  const commentService = require("../../services/commentService");
  const { commentRateLimiter } = require("../../services/commentRateLimiter");
  const commentRoutes = require("../../routes/commentRoutes");

  const articleId = "64b7f0f2a1b2c3d4e5f60718";
  const commentId = "64b7f0f2a1b2c3d4e5f60719";
  const spiedFunctions = [
    [commentRateLimiter, "reserve"],
    [commentService, "createComment"],
    [commentService, "findCommentForChange"],
    [commentService, "updateCommentBody"],
    [commentService, "deleteComment"],
  ];
  const originals = new Map();
  let calls;
  let server;
  let baseUrl;

  before(async () => {
    for (const [owner, name] of spiedFunctions) {
      originals.set(`${name}`, owner[name]);
      owner[name] = (...args) => {
        calls.push(name);
        return originals.get(name)(...args);
      };
    }
    const app = express();
    app.use(express.urlencoded({ extended: true }));
    app.use(commentRoutes);
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => {
    for (const [owner, name] of spiedFunctions) {
      owner[name] = originals.get(name);
    }
    server.close();
  });

  function send(method, url, contentType, body) {
    calls = [];
    return fetch(baseUrl + url, { method, headers: { "Content-Type": contentType }, body });
  }

  const commentsUrl = `/api/public/articles/${articleId}/comments`;
  const commentUrl = `/api/public/comments/${commentId}`;

  it("a form POST is rejected with 415 before any quota reservation or write", async () => {
    for (const contentType of ["application/x-www-form-urlencoded", "text/plain", "multipart/form-data; boundary=x"]) {
      const response = await send("POST", commentsUrl, contentType, "displayName=Mallory&body=spam");
      assert.strictEqual(response.status, 415, contentType);
      assert.match(response.headers.get("content-type"), /application\/json/);
      assert.deepStrictEqual(calls, [], contentType);
    }
  });

  it("a form PATCH is rejected with 415 before any lookup or write", async () => {
    const response = await send("PATCH", commentUrl, "application/x-www-form-urlencoded", "body=changed");
    assert.strictEqual(response.status, 415);
    assert.deepStrictEqual(calls, []);
  });

  it("a request without a body is rejected the same way", async () => {
    const response = await fetch(baseUrl + commentsUrl, { method: "POST" });
    assert.strictEqual(response.status, 415);
  });

  it("JSON still reaches the controller, with or without a charset parameter", async () => {
    // An empty object passes the content-type check and fails field validation with 400.
    for (const contentType of ["application/json", "application/json; charset=utf-8", "APPLICATION/JSON;charset=UTF-8"]) {
      const created = await send("POST", commentsUrl, contentType, "{}");
      assert.strictEqual(created.status, 400, contentType);
      assert.match((await created.json()).error, /name/i);
      const updated = await send("PATCH", commentUrl, contentType, "{}");
      assert.strictEqual(updated.status, 400, contentType);
    }
  });

  it("DELETE needs no body or content type", async () => {
    // Malformed id: answers 404 from the controller without any database.
    const response = await fetch(`${baseUrl}/api/public/comments/not-an-id`, { method: "DELETE" });
    assert.strictEqual(response.status, 404);
  });
});
