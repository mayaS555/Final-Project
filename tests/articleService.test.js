// Tests for the article workflow in services/articleService.js (owned by B).
// Permission and input checks happen before any database call, so they run without MongoDB.
// The lifecycle part needs MONGODB_TEST_URI (see tests/testDatabase.js).
// Run: node --test tests/

const { describe, test, before, after, beforeEach, mock } = require("node:test");
const assert = require("assert");
const mongoose = require("mongoose");
const Article = require("../models/Article");
const articleService = require("../services/articleService");
const publicArticleService = require("../services/publicArticleService");
const { skipWithoutDatabase, connectTestDatabase, disconnectTestDatabase } = require("./testDatabase");

const reporter = { _id: new mongoose.Types.ObjectId(), role: "reporter", name: "Noa" };
const otherReporter = { _id: new mongoose.Types.ObjectId(), role: "reporter", name: "Dan" };
const editor = { _id: new mongoose.Types.ObjectId(), role: "editor", name: "Ed" };
const admin = { _id: new mongoose.Types.ObjectId(), role: "admin", name: "Ada" };
const completeCopy = { title: "Harbor report", summary: "Short", content: "First\n\nSecond", category: "Sports" };

/**
 * Builds an unsaved article owned by `reporter`.
 * @param {Object} [overrides] Fields to set or replace.
 * @returns {Object} A new Article document (not saved).
 * @example buildArticle({ status: "pending", draft: completeCopy })
 */
function buildArticle(overrides = {}) {
  return new Article({ author: reporter._id, authorName: reporter.name, ...overrides });
}

/**
 * Builds an unsaved published article owned by `reporter`.
 * @returns {Object} A new Article document with an approved version.
 * @example const article = buildPublished();
 */
function buildPublished() {
  const now = new Date();
  return buildArticle({
    status: "published",
    draft: completeCopy,
    approved: { ...completeCopy, imageUrl: "", authorName: reporter.name, publishedAt: now, updatedAt: now },
  });
}

describe("checks before the database (no MongoDB needed)", () => {
  test("an editor cannot create a draft", async () => {
    await assert.rejects(articleService.createDraft(editor), { status: 403 });
  });

  test("saveWorkingCopy rejects a body that is not an object", async () => {
    for (const body of [null, "text", ["title"]]) {
      await assert.rejects(articleService.saveWorkingCopy(buildArticle(), reporter, body), { status: 400 });
    }
  });

  test("saveWorkingCopy rejects keys outside the working copy", async () => {
    for (const key of ["status", "author", "approved", "publishCount", "editorNote", "draft"]) {
      await assert.rejects(articleService.saveWorkingCopy(buildArticle(), reporter, { [key]: "x" }), {
        status: 400,
        message: `These fields cannot be changed here: ${key}.`,
      });
    }
  });

  test("saveWorkingCopy rejects values that are not text", async () => {
    for (const value of [{ $gt: "" }, 5, null, ["a"]]) {
      await assert.rejects(articleService.saveWorkingCopy(buildArticle(), reporter, { title: value }), { status: 400 });
    }
  });

  test("saveWorkingCopy rejects unsafe image URLs", async () => {
    for (const imageUrl of ["javascript:alert(1)", "//evil.example/a.png", "data:image/png;base64,AAAA"]) {
      await assert.rejects(articleService.saveWorkingCopy(buildArticle(), reporter, { imageUrl }), { status: 400 });
    }
  });

  test("saveWorkingCopy refuses another reporter and locked statuses", async () => {
    await assert.rejects(articleService.saveWorkingCopy(buildArticle(), otherReporter, { title: "x" }), { status: 403 });
    await assert.rejects(articleService.saveWorkingCopy(buildArticle({ status: "pending" }), reporter, { title: "x" }), {
      status: 403,
    });
    await assert.rejects(articleService.saveWorkingCopy(buildPublished(), reporter, { title: "x" }), { status: 403 });
    await assert.rejects(articleService.saveWorkingCopy(buildArticle(), editor, { title: "x" }), { status: 403 });
  });

  test("saveWorkingCopy with no fields returns the article unchanged", async () => {
    const article = buildArticle();
    assert.equal(await articleService.saveWorkingCopy(article, reporter, {}), article);
  });

  test("submit needs title, content and category", async () => {
    await assert.rejects(articleService.submit(buildArticle(), reporter), {
      status: 400,
      message: "Please fill in: title, content, category.",
    });
    const noCategory = buildArticle({ draft: { title: "T", content: "C" } });
    await assert.rejects(articleService.submit(noCategory, reporter), { message: "Please fill in: category." });
  });

  test("submit refuses another reporter, an editor and a wrong status", async () => {
    const article = buildArticle({ draft: completeCopy });
    await assert.rejects(articleService.submit(article, otherReporter), { status: 403 });
    await assert.rejects(articleService.submit(article, editor), { status: 403 });
    await assert.rejects(articleService.submit(buildArticle({ status: "pending", draft: completeCopy }), reporter), {
      status: 409,
    });
    await assert.rejects(articleService.submit(buildPublished(), reporter), { status: 409 });
  });

  test("approve refuses a reporter, a wrong status and an incomplete copy", async () => {
    await assert.rejects(articleService.approve(buildArticle({ status: "pending", draft: completeCopy }), reporter), {
      status: 403,
    });
    await assert.rejects(articleService.approve(buildArticle({ draft: completeCopy }), editor), { status: 409 });
    await assert.rejects(articleService.approve(buildArticle({ status: "returned", draft: completeCopy }), editor), {
      status: 409,
    });
    await assert.rejects(articleService.approve(buildArticle({ status: "pending" }), editor), { status: 400 });
  });

  test("returnToReporter needs an editor, a pending article and a note", async () => {
    const pending = buildArticle({ status: "pending", draft: completeCopy });
    await assert.rejects(articleService.returnToReporter(pending, reporter, "Fix it"), { status: 403 });
    await assert.rejects(articleService.returnToReporter(buildArticle(), editor, "Fix it"), { status: 409 });
    for (const note of [undefined, "", "   ", 5, { text: "x" }]) {
      await assert.rejects(articleService.returnToReporter(pending, editor, note), { status: 400 });
    }
    await assert.rejects(articleService.returnToReporter(pending, editor, "x".repeat(1001)), { status: 400 });
  });

  test("startRevision needs the author and a published article", async () => {
    await assert.rejects(articleService.startRevision(buildPublished(), otherReporter), { status: 403 });
    await assert.rejects(articleService.startRevision(buildPublished(), editor), { status: 403 });
    await assert.rejects(articleService.startRevision(buildArticle(), reporter), { status: 409 });
  });

  test("deleteArticle refuses what canDelete refuses", async () => {
    await assert.rejects(articleService.deleteArticle(buildArticle(), otherReporter), { status: 403 });
    await assert.rejects(articleService.deleteArticle(buildArticle({ status: "pending" }), reporter), { status: 403 });
    await assert.rejects(articleService.deleteArticle(buildPublished(), reporter), { status: 403 });
  });
});

describe("full lifecycle with MongoDB", { skip: skipWithoutDatabase }, () => {
  let logged;

  before(async () => {
    await connectTestDatabase();
    publicArticleService.useArticleModel(Article);
  });

  after(disconnectTestDatabase);

  beforeEach(() => {
    logged = mock.method(console, "log", () => {});
  });

  /**
   * The events written to the log since the current test started.
   * @returns {string[]} Event names, for example ["submit", "approve"].
   * @example assert.deepEqual(loggedEvents(), ["submit"]);
   */
  function loggedEvents() {
    return logged.mock.calls
      .map((call) => String(call.arguments[0]).match(/\[article\] (\w+)/))
      .filter(Boolean)
      .map((match) => match[1]);
  }

  /**
   * Creates a draft for `reporter` with a complete working copy, saved in the database.
   * @returns {Promise<Object>} The saved draft.
   * @example const draft = await createCompleteDraft();
   */
  async function createCompleteDraft() {
    const draft = await articleService.createDraft(reporter);
    return articleService.saveWorkingCopy(draft, reporter, completeCopy);
  }

  test("createDraft saves an empty draft owned by the reporter", async () => {
    const article = await articleService.createDraft(reporter);
    assert.equal(article.status, "draft");
    assert.equal(String(article.author), String(reporter._id));
    assert.equal(article.authorName, "Noa");
    assert.equal(await Article.exists({ _id: article._id }).then(Boolean), true);
  });

  test("an admin can write, review and revise articles like a reporter and an editor", async () => {
    let article = await articleService.createDraft(admin);
    assert.equal(String(article.author), String(admin._id));
    assert.equal(article.authorName, "Ada");

    article = await articleService.saveWorkingCopy(article, admin, completeCopy);
    article = await articleService.submit(article, admin);
    assert.equal(article.status, "pending");

    article = await articleService.saveWorkingCopy(article, admin, { title: "Admin edit" });
    article = await articleService.returnToReporter(article, admin, "Add a source.");
    assert.equal(article.status, "returned");

    article = await articleService.submit(article, admin);
    article = (await articleService.approve(article, admin)).article;
    assert.equal(article.status, "published");

    article = await articleService.startRevision(article, admin);
    assert.equal(article.status, "draft");

    const reporterPending = await articleService.submit(await createCompleteDraft(), reporter);
    await articleService.deleteArticle(reporterPending, admin);
    assert.equal(await Article.exists({ _id: reporterPending._id }), null);
  });

  test("saveWorkingCopy trims text, normalizes line breaks and leaves other fields alone", async () => {
    const draft = await articleService.createDraft(reporter);
    const saved = await articleService.saveWorkingCopy(draft, reporter, { title: "  Storm  ", content: "a\r\n\r\nb " });
    assert.equal(saved.draft.title, "Storm");
    assert.equal(saved.draft.content, "a\n\nb");
    assert.equal(saved.status, "draft");
    assert.equal(saved.approved, undefined);
    const partial = await articleService.saveWorkingCopy(saved, reporter, { summary: "Only this" });
    assert.equal(partial.draft.title, "Storm");
    assert.equal(partial.draft.summary, "Only this");
  });

  test("saveWorkingCopy turns model validation errors into 400", async () => {
    const draft = await articleService.createDraft(reporter);
    await assert.rejects(articleService.saveWorkingCopy(draft, reporter, { category: "Gossip" }), {
      status: 400,
      message: "Invalid value for category.",
    });
    await assert.rejects(articleService.saveWorkingCopy(draft, reporter, { title: "x".repeat(201) }), {
      status: 400,
      message: "Invalid value for title.",
    });
  });

  test("submit, return and resubmit", async () => {
    let article = await articleService.submit(await createCompleteDraft(), reporter);
    assert.equal(article.status, "pending");

    article = await articleService.returnToReporter(article, editor, "  Add a source.  ");
    assert.equal(article.status, "returned");
    assert.equal(article.editorNote, "Add a source.");

    article = await articleService.saveWorkingCopy(article, reporter, { summary: "With a source" });
    article = await articleService.submit(article, reporter);
    assert.equal(article.status, "pending");
    assert.equal(article.editorNote, "");
    assert.deepEqual(loggedEvents(), ["submit", "return", "submit"]);
  });

  test("a pending article is not public", async () => {
    const article = await articleService.submit(await createCompleteDraft(), reporter);
    assert.equal(await publicArticleService.getPublishedArticleById(String(article._id)), null);
  });

  test("an autosave that arrives after submit gets 409 and changes nothing", async () => {
    const stale = await createCompleteDraft();
    await articleService.submit(stale, reporter);
    await assert.rejects(articleService.saveWorkingCopy(stale, reporter, { title: "Late" }), { status: 409 });
    const stored = await Article.findById(stale._id);
    assert.equal(stored.draft.title, "Harbor report");
  });

  test("an editor may fix a pending article before approving", async () => {
    const pending = await articleService.submit(await createCompleteDraft(), reporter);
    const fixed = await articleService.saveWorkingCopy(pending, editor, { title: "Harbor report, fixed" });
    const { article } = await articleService.approve(fixed, editor);
    assert.equal(article.approved.title, "Harbor report, fixed");
  });

  test("approve publishes the working copy", async () => {
    const pending = await articleService.submit(await createCompleteDraft(), reporter);
    const { article, isFirstPublish } = await articleService.approve(pending, editor);

    assert.equal(isFirstPublish, true);
    assert.equal(article.status, "published");
    assert.equal(article.publishCount, 1);
    assert.equal(article.approved.title, "Harbor report");
    assert.equal(article.approved.authorName, "Noa");
    assert.ok(article.approved.publishedAt instanceof Date);
    assert.equal(article.approved.updatedAt.getTime(), article.approved.publishedAt.getTime());

    const page = await publicArticleService.getPublishedArticleById(String(article._id));
    assert.equal(page.title, "Harbor report");
    assert.equal(page.content, "First\n\nSecond");
  });

  test("two approve clicks at the same time publish once", async () => {
    const pending = await articleService.submit(await createCompleteDraft(), reporter);
    const results = await Promise.allSettled([
      articleService.approve(pending, editor),
      articleService.approve(pending, editor),
    ]);
    const succeeded = results.filter((result) => result.status === "fulfilled");
    const failed = results.filter((result) => result.status === "rejected");
    assert.equal(succeeded.length, 1);
    assert.equal(failed[0].reason.status, 409);
    const stored = await Article.findById(pending._id);
    assert.equal(stored.publishCount, 1);
  });

  test("a revision keeps the live version until it is approved again", async () => {
    const pending = await articleService.submit(await createCompleteDraft(), reporter);
    const first = await articleService.approve(pending, editor);
    const firstPublishedAt = first.article.approved.publishedAt.getTime();

    let article = await articleService.startRevision(first.article, reporter);
    assert.equal(article.status, "draft");
    assert.equal(article.draft.title, "Harbor report");
    assert.equal(article.draft.content, "First\n\nSecond");

    article = await articleService.saveWorkingCopy(article, reporter, { title: "Harbor report, updated" });
    article = await articleService.submit(article, reporter);
    const livePage = await publicArticleService.getPublishedArticleById(String(article._id));
    assert.equal(livePage.title, "Harbor report");

    const second = await articleService.approve(article, editor);
    assert.equal(second.isFirstPublish, false);
    assert.equal(second.article.publishCount, 2);
    assert.equal(second.article.approved.title, "Harbor report, updated");
    assert.equal(second.article.approved.publishedAt.getTime(), firstPublishedAt);
    assert.ok(second.article.approved.updatedAt.getTime() >= firstPublishedAt);
  });

  test("deleteArticle removes a reporter's draft and any article for an editor", async () => {
    const draft = await articleService.createDraft(reporter);
    await articleService.deleteArticle(draft, reporter);
    assert.equal(await Article.exists({ _id: draft._id }), null);

    const pending = await articleService.submit(await createCompleteDraft(), reporter);
    const { article } = await articleService.approve(pending, editor);
    await articleService.deleteArticle(article, editor);
    assert.equal(await Article.exists({ _id: article._id }), null);
    assert.deepEqual(loggedEvents(), ["delete", "submit", "approve", "delete"]);
  });

  test("deleting an article whose status changed meanwhile gives 409", async () => {
    const stale = await createCompleteDraft();
    await articleService.submit(stale, reporter);
    await assert.rejects(articleService.deleteArticle(stale, reporter), { status: 409 });
    assert.ok(await Article.exists({ _id: stale._id }));
  });
});
