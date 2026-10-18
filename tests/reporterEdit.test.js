// Tests for the edit page: toEditView and renderEditPage in controllers/reporterController.js, its route in
// routes/reporterRoutes.js and views/reporter/edit.ejs (owned by B). toEditView is pure and needs no database;
// the page is requested over HTTP from the test app in tests/testServer.js, and the parts that load
// articles need MONGODB_TEST_URI (see tests/testDatabase.js).
// Run: node --test tests/

const { describe, test, before, after, mock } = require("node:test");
const assert = require("assert");
const mongoose = require("mongoose");
const Article = require("../models/Article");
const articleService = require("../services/articleService");
const reporterRoutes = require("../routes/reporterRoutes");
const { toEditView } = require("../controllers/reporterController");
const { ARTICLE_CATEGORIES } = require("../models/articleCategories");
const { skipWithoutDatabase, connectTestDatabase, disconnectTestDatabase } = require("./testDatabase");
const { startTestServer } = require("./testServer");

const USERS = {
  noa: { _id: new mongoose.Types.ObjectId(), role: "reporter", name: "Noa" },
  dan: { _id: new mongoose.Types.ObjectId(), role: "reporter", name: "Dan" },
  ed: { _id: new mongoose.Types.ObjectId(), role: "editor", name: "Ed" },
};
const publishedAt = new Date("2026-10-01T09:00:00Z");

let testServer;

/**
 * Requests the edit page of an article.
 * @param {string} articleId The article id (any text, to test bad ids).
 * @param {string} [user] A USERS key, or undefined for nobody logged in.
 * @returns {Promise<{ status: number, html: string, cacheControl: string }>} The answer.
 * @example const { html } = await getEditPage(id, "noa");
 */
async function getEditPage(articleId, user) {
  const response = await fetch(`${testServer.baseUrl}/reporter/articles/${articleId}/edit`, {
    headers: user ? { "X-Test-User": user } : {},
  });
  return { status: response.status, html: await response.text(), cacheControl: response.headers.get("cache-control") };
}

/**
 * Builds an unsaved article owned by Noa.
 * @param {Object} [fields] Fields to set or replace.
 * @returns {Object} A new Article document.
 * @example buildArticle({ status: "pending" })
 */
function buildArticle(fields = {}) {
  return new Article({ author: USERS.noa._id, authorName: "Noa", ...fields });
}

describe("toEditView (no MongoDB needed)", () => {
  test("the fields come from the working copy, not the public version", () => {
    const article = buildArticle({
      draft: { title: "Working", summary: "S", content: "C", imageUrl: "/a.png", category: "Sports" },
      approved: { title: "Live", category: "Culture", authorName: "Noa", publishedAt, updatedAt: publishedAt },
    });
    assert.deepEqual(toEditView(article, USERS.noa).fields, {
      title: "Working",
      summary: "S",
      content: "C",
      imageUrl: "/a.png",
      category: "Sports",
    });
  });

  test("the author edits and submits a draft", () => {
    const view = toEditView(buildArticle(), USERS.noa);
    assert.deepEqual([view.canEdit, view.canSubmit, view.submitLabel], [true, true, "Submit for approval"]);
    assert.equal(view.readOnlyMessage, "");
    assert.equal(view.dashboardUrl, "/reporter");
  });

  test("a returned article shows the note and offers Resubmit", () => {
    const view = toEditView(buildArticle({ status: "returned", editorNote: "Add a source." }), USERS.noa);
    assert.deepEqual([view.canEdit, view.canSubmit, view.submitLabel], [true, true, "Resubmit"]);
    assert.equal(view.editorNote, "Add a source.");
  });

  test("the editor's note is only shown while the article is returned", () => {
    assert.equal(toEditView(buildArticle({ status: "pending", editorNote: "Old" }), USERS.noa).editorNote, "");
  });

  test("pending is read-only for the author, with the reason", () => {
    const view = toEditView(buildArticle({ status: "pending" }), USERS.noa);
    assert.deepEqual([view.canEdit, view.canSubmit], [false, false]);
    assert.match(view.readOnlyMessage, /waiting for an editor/);
  });

  test("published is read-only for the author, pointing to Edit published article", () => {
    const view = toEditView(
      buildArticle({ status: "published", approved: { title: "Live", authorName: "Noa", publishedAt, updatedAt: publishedAt } }),
      USERS.noa
    );
    assert.deepEqual([view.canEdit, view.canSubmit, view.isLive], [false, false, true]);
    assert.match(view.readOnlyMessage, /Edit published article/);
  });

  test("an editor edits only a pending article and never submits", () => {
    const pending = toEditView(buildArticle({ status: "pending" }), USERS.ed);
    assert.deepEqual([pending.canEdit, pending.canSubmit, pending.dashboardUrl], [true, false, null]);
    const draft = toEditView(buildArticle(), USERS.ed);
    assert.deepEqual([draft.canEdit, draft.canSubmit], [false, false]);
    assert.match(draft.readOnlyMessage, /Editors can change an article only while it is waiting/);
  });

  test("isLive is true only with a public version", () => {
    assert.equal(toEditView(buildArticle(), USERS.noa).isLive, false);
    const revising = buildArticle({ approved: { title: "Live", authorName: "Noa", publishedAt, updatedAt: publishedAt } });
    assert.equal(toEditView(revising, USERS.noa).isLive, true);
  });
});

describe("GET /reporter/articles/:id/edit access (no MongoDB needed)", () => {
  before(async () => {
    testServer = await startTestServer([reporterRoutes], USERS);
  });
  after(() => testServer.stop());

  test("nobody logged in gets 401", async () => {
    assert.equal((await getEditPage(String(new mongoose.Types.ObjectId()))).status, 401);
  });

  test("an invalid id gets 400", async () => {
    assert.equal((await getEditPage("not-an-id", "noa")).status, 400);
  });
});

describe("GET /reporter/articles/:id/edit with MongoDB", { skip: skipWithoutDatabase }, () => {
  const articles = {};

  before(async () => {
    await connectTestDatabase();
    testServer = await startTestServer([reporterRoutes], USERS);
    mock.method(console, "log", () => {});
    const { noa, ed } = USERS;

    articles.draft = await articleService.createDraft(noa);
    articles.draft = await articleService.saveWorkingCopy(articles.draft, noa, {
      title: "<b>Harbor</b> report",
      summary: "Short summary",
      content: "First paragraph\n\nSecond </textarea><script>alert(1)</script>",
      imageUrl: "/images/harbor.jpg",
      category: "Economy",
    });

    articles.returned = await articleService.createDraft(noa);
    articles.returned = await articleService.saveWorkingCopy(articles.returned, noa, {
      title: "Needs sources",
      content: "Text",
      category: "Sports",
    });
    articles.returned = await articleService.submit(articles.returned, noa);
    articles.returned = await articleService.returnToReporter(articles.returned, ed, "Add a second source.");

    articles.published = await articleService.createDraft(noa);
    articles.published = await articleService.saveWorkingCopy(articles.published, noa, {
      title: "Library news",
      content: "Text",
      category: "Culture",
    });
    articles.published = await articleService.submit(articles.published, noa);
    articles.published = (await articleService.approve(articles.published, ed)).article;

    articles.revising = await articleService.createDraft(noa);
    articles.revising = await articleService.saveWorkingCopy(articles.revising, noa, {
      title: "Old title",
      content: "Text",
      category: "Health",
    });
    articles.revising = await articleService.submit(articles.revising, noa);
    articles.revising = (await articleService.approve(articles.revising, ed)).article;
    articles.revising = await articleService.startRevision(articles.revising, noa);
    articles.revising = await articleService.saveWorkingCopy(articles.revising, noa, { title: "New title" });

    articles.pending = await articleService.createDraft(noa);
    articles.pending = await articleService.saveWorkingCopy(articles.pending, noa, {
      title: "Waiting",
      content: "Text",
      category: "World",
    });
    articles.pending = await articleService.submit(articles.pending, noa);
  });

  after(async () => {
    mock.restoreAll();
    await testServer.stop();
    await disconnectTestDatabase();
  });

  test("another reporter gets 403, a missing article 404", async () => {
    assert.equal((await getEditPage(String(articles.draft._id), "dan")).status, 403);
    assert.equal((await getEditPage(String(new mongoose.Types.ObjectId()), "noa")).status, 404);
  });

  test("a draft is filled from the working copy, escaped, and not cached", async () => {
    const { status, html, cacheControl } = await getEditPage(String(articles.draft._id), "noa");
    assert.equal(status, 200);
    assert.equal(cacheControl, "private, no-store");
    assert.ok(html.includes('value="&lt;b&gt;Harbor&lt;/b&gt; report"'));
    assert.ok(html.includes(">Short summary</textarea>"));
    assert.ok(html.includes("Second &lt;/textarea&gt;&lt;script&gt;alert(1)&lt;/script&gt;</textarea>"));
    assert.ok(!html.includes("<script>alert(1)</script>"));
    assert.ok(html.includes('value="/images/harbor.jpg"'));
    assert.ok(html.includes('<option value="Economy" selected>Economy</option>'));
  });

  test("the category list is the shared constant", async () => {
    const { html } = await getEditPage(String(articles.draft._id), "noa");
    for (const category of ARTICLE_CATEGORIES) {
      assert.ok(html.includes(`<option value="${category}"`), category);
    }
  });

  test("every input has a label", async () => {
    const { html } = await getEditPage(String(articles.draft._id), "noa");
    for (const id of ["rep-title", "rep-summary", "rep-content", "rep-image", "rep-category"]) {
      assert.ok(html.includes(`<label for="${id}">`), id);
      assert.ok(html.includes(`id="${id}"`), id);
    }
  });

  test("a draft is editable with Submit for approval and Back to dashboard", async () => {
    const { html } = await getEditPage(String(articles.draft._id), "noa");
    assert.ok(html.includes('<fieldset class="rep-fields">'));
    assert.ok(html.includes(">Submit for approval</button>"));
    assert.ok(html.includes('href="/reporter">Back to dashboard</a>'));
    assert.ok(!html.includes("rep-read-only"));
    assert.ok(!html.includes("Readers still see the published version"));
  });

  test("a returned article shows the editor's note at the top and Resubmit", async () => {
    const { html } = await getEditPage(String(articles.returned._id), "noa");
    assert.ok(html.includes("The editor returned this article"));
    assert.ok(html.includes("Add a second source."));
    assert.ok(html.indexOf("Add a second source.") < html.indexOf("<form"));
    assert.ok(html.includes(">Resubmit</button>"));
  });

  test("a pending article is read-only with the reason, without an error", async () => {
    const { status, html } = await getEditPage(String(articles.pending._id), "noa");
    assert.equal(status, 200);
    assert.ok(html.includes('<fieldset class="rep-fields" disabled>'));
    assert.ok(html.includes("waiting for an editor"));
    assert.ok(!html.includes('id="rep-submit"'));
  });

  test("a published article is read-only and shows the public-version banner", async () => {
    const { html } = await getEditPage(String(articles.published._id), "noa");
    assert.ok(html.includes('<fieldset class="rep-fields" disabled>'));
    assert.ok(html.includes("Readers still see the published version until an editor approves your changes."));
    assert.ok(html.includes(`href="/articles/${articles.published._id}"`));
  });

  test("a published article being revised is editable, shows the new title and the banner", async () => {
    const { html } = await getEditPage(String(articles.revising._id), "noa");
    assert.ok(html.includes('<fieldset class="rep-fields">'));
    assert.ok(html.includes('value="New title"'));
    assert.ok(html.includes("Readers still see the published version"));
  });

  test("an editor can open a pending article and edit it, without Submit or the reporter dashboard link", async () => {
    const { status, html } = await getEditPage(String(articles.pending._id), "ed");
    assert.equal(status, 200);
    assert.ok(html.includes('<fieldset class="rep-fields">'));
    assert.ok(!html.includes('id="rep-submit"'));
    assert.ok(!html.includes("Back to dashboard"));
  });

  test("the page shows the latest saved version on every request", async () => {
    await articleService.saveWorkingCopy(await Article.findById(articles.draft._id), USERS.noa, { summary: "Changed elsewhere" });
    const { html } = await getEditPage(String(articles.draft._id), "noa");
    assert.ok(html.includes(">Changed elsewhere</textarea>"));
  });
});
