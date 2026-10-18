// Tests for the reporter dashboard: controllers/reporterController.js, routes/reporterRoutes.js and
// views/reporter/dashboard.ejs (owned by B). The row rules are pure and need no database. The page is
// requested over HTTP from the test app in tests/testServer.js; the parts that list articles need MONGODB_TEST_URI (see tests/testDatabase.js).
// Run: node --test tests/

const { describe, test, before, after, mock } = require("node:test");
const assert = require("assert");
const mongoose = require("mongoose");
const Article = require("../models/Article");
const articleService = require("../services/articleService");
const reporterRoutes = require("../routes/reporterRoutes");
const { toDashboardRow, STATUS_LABELS } = require("../controllers/reporterController");
const { skipWithoutDatabase, connectTestDatabase, disconnectTestDatabase } = require("./testDatabase");
const { startTestServer } = require("./testServer");

const USERS = {
  noa: { _id: new mongoose.Types.ObjectId(), role: "reporter", name: "Noa" },
  dan: { _id: new mongoose.Types.ObjectId(), role: "reporter", name: "Dan" },
  ed: { _id: new mongoose.Types.ObjectId(), role: "editor", name: "Ed" },
};
const publishedAt = new Date("2026-10-01T09:00:00Z");

let testServer;
let baseUrl;

/**
 * Starts the test app (tests/testServer.js) on a free port.
 * @returns {Promise<void>} Resolves when it listens; sets baseUrl.
 * @example before(startServer);
 */
async function startServer() {
  testServer = await startTestServer([reporterRoutes], USERS);
  baseUrl = testServer.baseUrl;
}

/**
 * Stops the test app.
 * @returns {Promise<void>} Resolves when closed.
 * @example after(stopServer);
 */
function stopServer() {
  return testServer.stop();
}

/**
 * Requests the dashboard.
 * @param {string} [user] A USERS key, or undefined for nobody logged in.
 * @param {string} [query] Query string, for example "?status=draft".
 * @returns {Promise<{ status: number, html: string }>} The status and the page.
 * @example const { html } = await getDashboard("noa");
 */
async function getDashboard(user, query = "") {
  const response = await fetch(`${baseUrl}/reporter${query}`, { headers: user ? { "X-Test-User": user } : {} });
  return { status: response.status, html: await response.text() };
}

/**
 * Returns the HTML of one article's row.
 * @param {string} html The page.
 * @param {string} articleId The article id.
 * @returns {string} The row's markup, or "" when the article is not listed.
 * @example const row = findRow(html, String(article._id));
 */
function findRow(html, articleId) {
  const rows = html.split('<li class="rep-row"').slice(1);
  return rows.find((row) => row.includes(`data-article-id="${articleId}"`)) || "";
}

describe("toDashboardRow (no MongoDB needed)", () => {
  const id = new mongoose.Types.ObjectId();

  /**
   * Builds a lean article like articleService.listArticles returns.
   * @param {Object} fields Fields to set.
   * @returns {Object} The article.
   * @example leanArticle({ status: "pending" })
   */
  function leanArticle(fields) {
    return { _id: id, status: "draft", draft: { title: "", category: "" }, editorNote: "", updatedAt: publishedAt, ...fields };
  }

  test("the title falls back to the public title, then to Untitled", () => {
    assert.equal(toDashboardRow(leanArticle({ draft: { title: "Working" }, approved: { title: "Live", publishedAt } })).title, "Working");
    assert.equal(toDashboardRow(leanArticle({ draft: { title: "" }, approved: { title: "Live", publishedAt } })).title, "Live");
    assert.equal(toDashboardRow(leanArticle({})).title, "Untitled");
  });

  test("the badges use the Hebrew labels", () => {
    assert.deepEqual(STATUS_LABELS, {
      draft: "בהכנה",
      pending: "ממתינה לאישור עורך",
      published: "פורסמה",
      returned: "הוחזרה לתיקונים",
    });
    assert.equal(toDashboardRow(leanArticle({ status: "returned" })).statusLabel, "הוחזרה לתיקונים");
  });

  test("a never-published draft can be edited and deleted, not viewed live or revised", () => {
    const row = toDashboardRow(leanArticle({}));
    assert.deepEqual([row.canEdit, row.canDelete, row.isLive, row.canRevise], [true, true, false, false]);
  });

  test("a pending article has no actions", () => {
    const row = toDashboardRow(leanArticle({ status: "pending" }));
    assert.deepEqual([row.canEdit, row.canDelete, row.isLive, row.canRevise], [false, false, false, false]);
  });

  test("a returned article can be edited and deleted", () => {
    const row = toDashboardRow(leanArticle({ status: "returned", editorNote: "Add a source." }));
    assert.deepEqual([row.canEdit, row.canDelete], [true, true]);
    assert.equal(row.editorNote, "Add a source.");
  });

  test("a published article can be viewed live and revised, not edited or deleted", () => {
    const row = toDashboardRow(leanArticle({ status: "published", approved: { title: "Live", publishedAt } }));
    assert.deepEqual([row.isLive, row.canRevise, row.canEdit, row.canDelete], [true, true, false, false]);
    assert.equal(row.hasPendingRevision, false);
    assert.equal(row.liveUrl, `/articles/${id}`);
  });

  test("a published article being revised shows the pending-revision note and cannot be deleted", () => {
    const row = toDashboardRow(leanArticle({ status: "draft", approved: { title: "Live", publishedAt } }));
    assert.deepEqual([row.hasPendingRevision, row.isLive, row.canEdit, row.canDelete], [true, true, true, false]);
  });

  test("links point at the edit page and C's article page", () => {
    const row = toDashboardRow(leanArticle({}));
    assert.equal(row.editUrl, `/reporter/articles/${id}/edit`);
    assert.equal(row.liveUrl, `/articles/${id}`);
  });
});

describe("GET /reporter access (no MongoDB needed)", () => {
  before(startServer);
  after(stopServer);

  test("nobody logged in gets 401", async () => {
    assert.equal((await getDashboard()).status, 401);
  });

  test("an editor gets 403", async () => {
    assert.equal((await getDashboard("ed")).status, 403);
  });

  test("an unknown or repeated status filter gets 400", async () => {
    assert.equal((await getDashboard("noa", "?status=live")).status, 400);
    assert.equal((await getDashboard("noa", "?status=draft&status=pending")).status, 400);
  });
});

describe("GET /reporter with MongoDB", { skip: skipWithoutDatabase }, () => {
  const articles = {};

  before(async () => {
    await connectTestDatabase();
    await startServer();
    mock.method(console, "log", () => {});
    const noa = USERS.noa;

    articles.draft = await articleService.createDraft(noa);
    articles.draft = await articleService.saveWorkingCopy(articles.draft, noa, {
      title: "<script>alert(1)</script> Harbor",
      category: "Sports",
    });

    articles.returned = await articleService.createDraft(noa);
    articles.returned = await articleService.saveWorkingCopy(articles.returned, noa, {
      title: "Needs sources",
      content: "Text",
      category: "Economy",
    });
    articles.returned = await articleService.submit(articles.returned, noa);
    articles.returned = await articleService.returnToReporter(articles.returned, USERS.ed, "Add a second source.");

    articles.published = await articleService.createDraft(noa);
    articles.published = await articleService.saveWorkingCopy(articles.published, noa, {
      title: "Library news",
      content: "Text",
      category: "Culture",
    });
    articles.published = await articleService.submit(articles.published, noa);
    articles.published = (await articleService.approve(articles.published, USERS.ed)).article;

    articles.revising = await articleService.createDraft(noa);
    articles.revising = await articleService.saveWorkingCopy(articles.revising, noa, {
      title: "Old title",
      content: "Text",
      category: "Health",
    });
    articles.revising = await articleService.submit(articles.revising, noa);
    articles.revising = (await articleService.approve(articles.revising, USERS.ed)).article;
    articles.revising = await articleService.startRevision(articles.revising, noa);

    articles.other = await articleService.createDraft(USERS.dan);
    await articleService.saveWorkingCopy(articles.other, USERS.dan, { title: "Dan's story" });
  });

  after(async () => {
    mock.restoreAll();
    await stopServer();
    await disconnectTestDatabase();
  });

  test("lists only the reporter's own articles", async () => {
    const { status, html } = await getDashboard("noa");
    assert.equal(status, 200);
    for (const name of ["draft", "returned", "published", "revising"]) {
      assert.ok(findRow(html, String(articles[name]._id)), name);
    }
    assert.equal(findRow(html, String(articles.other._id)), "");
    assert.ok(!html.includes("Dan's story"));
  });

  test("escapes titles", async () => {
    const { html } = await getDashboard("noa");
    assert.ok(!html.includes("<script>alert(1)</script>"));
    assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt; Harbor"));
  });

  test("a draft row: Hebrew badge, category, Edit and Delete only", async () => {
    const row = findRow((await getDashboard("noa")).html, String(articles.draft._id));
    assert.ok(row.includes("בהכנה"));
    assert.ok(row.includes("Sports"));
    assert.ok(row.includes(">Edit</a>"));
    assert.ok(row.includes('data-action="delete"'));
    assert.ok(!row.includes("View live"));
    assert.ok(!row.includes('data-action="revise"'));
  });

  test("a returned row shows the editor's note", async () => {
    const row = findRow((await getDashboard("noa")).html, String(articles.returned._id));
    assert.ok(row.includes("הוחזרה לתיקונים"));
    assert.ok(row.includes("Add a second source."));
    assert.ok(row.includes(">Edit</a>"));
  });

  test("a published row: View live and Edit published article, no Edit or Delete", async () => {
    const row = findRow((await getDashboard("noa")).html, String(articles.published._id));
    assert.ok(row.includes("פורסמה"));
    assert.ok(row.includes(`href="/articles/${articles.published._id}"`));
    assert.ok(row.includes('data-action="revise"'));
    assert.ok(!row.includes(">Edit</a>"));
    assert.ok(!row.includes('data-action="delete"'));
    assert.ok(!row.includes("A new version is in progress"));
  });

  test("a published article being revised shows the note, View live and Edit", async () => {
    const row = findRow((await getDashboard("noa")).html, String(articles.revising._id));
    assert.ok(row.includes("A new version is in progress"));
    assert.ok(row.includes("View live"));
    assert.ok(row.includes(">Edit</a>"));
    assert.ok(!row.includes('data-action="delete"'));
  });

  test("?status= filters the list and marks the active tab", async () => {
    const { html } = await getDashboard("noa", "?status=returned");
    assert.ok(findRow(html, String(articles.returned._id)));
    assert.equal(findRow(html, String(articles.draft._id)), "");
    assert.ok(html.includes('href="/reporter?status=returned" lang="he" dir="rtl" aria-current="page"'));
  });

  test("an empty filter result shows the empty message", async () => {
    const { html } = await getDashboard("noa", "?status=pending");
    assert.ok(html.includes("No articles with this status."));
    assert.ok(!html.includes('id="rep-empty" hidden'));
  });
});
