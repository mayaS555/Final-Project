// Tests for the data embedded in an article: comments (C's commentService), view buckets and publish events
// (D's impactAnalyticsService and articleService.approve). Needs MONGODB_TEST_URI (see tests/testDatabase.js).
// Run: node --test tests/

const { describe, test, before, after, mock } = require("node:test");
const assert = require("assert");
const mongoose = require("mongoose");
const Article = require("../models/Article");
const articleService = require("../services/articleService");
const commentService = require("../services/commentService");
const impact = require("../services/impactAnalyticsService");
const { skipWithoutDatabase, connectTestDatabase, disconnectTestDatabase } = require("./testDatabase");

const reporter = { _id: new mongoose.Types.ObjectId(), role: "reporter", name: "Rita" };
const editor = { _id: new mongoose.Types.ObjectId(), role: "editor", name: "Ed" };

/**
 * Creates an article and publishes it through the real workflow.
 * @returns {Promise<Object>} The published article document.
 * @example const article = await publishedArticle();
 */
async function publishedArticle() {
  let article = await articleService.createDraft(reporter);
  article = await articleService.saveWorkingCopy(article, reporter, { title: "T", content: "C", category: "Sports" });
  return (await articleService.approve(await articleService.submit(article, reporter), editor)).article;
}

describe("data embedded in articles", { skip: skipWithoutDatabase }, () => {
  before(async () => {
    await connectTestDatabase();
    mock.method(console, "log", () => {});
  });
  after(async () => {
    mock.restoreAll();
    await disconnectTestDatabase();
  });

  test("approve() records one publish event per approval", async () => {
    let article = await publishedArticle();
    article = await articleService.startRevision(article, reporter);
    article = (await articleService.approve(await articleService.submit(article, reporter), editor)).article;
    const { publishEvents } = await Article.findById(article._id).lean();
    assert.deepEqual(publishEvents.map((event) => [event.publishCount, event.isFirstPublish]), [[1, true], [2, false]]);
    assert.equal(publishEvents[1].publishedAt.getTime(), article.approved.updatedAt.getTime());
  });

  test("comments: create, page, edit and delete only by their device, without touching updatedAt", async () => {
    const article = await publishedArticle();
    const id = String(article._id);
    const created = [];
    for (let index = 0; index < 12; index += 1) {
      created.push(await commentService.createComment({ articleId: id, deviceId: "dev-a", displayName: "A", body: `c${index}` }));
    }
    assert.equal((await Article.findById(id).lean()).updatedAt.getTime(), article.updatedAt.getTime());
    assert.equal((await Article.findById(id).lean()).comments[0].deviceId, undefined, "deviceId is not selected by default");

    const first = await commentService.listComments(id, { viewerDeviceId: "dev-a" });
    const second = await commentService.listComments(id, { cursor: commentService.parseCursor(first.nextBefore) });
    assert.equal(first.items.length, 10);
    assert.equal(first.hasMore, true);
    assert.equal(second.items.length, 2);
    assert.equal(new Set([...first.items, ...second.items].map((item) => item.id)).size, 12);
    assert.ok(first.items.every((item) => item.canEdit && !("deviceId" in item)));

    const target = created[0].id;
    const found = await commentService.findCommentForChange(target);
    assert.equal(String(found.articleId), id);
    assert.equal(found.deviceId, "dev-a");
    assert.equal(await commentService.updateCommentBody(target, "dev-b", "hacked"), null);
    assert.equal((await commentService.updateCommentBody(target, "dev-a", "edited")).body, "edited");
    assert.equal(await commentService.deleteComment(target, "dev-b"), false);
    assert.equal(await commentService.deleteComment(target, "dev-a"), true);
    assert.equal(await commentService.findCommentForChange(target), null);
  });

  test("views: simultaneous visits keep one bucket per day and totalViews equal to the buckets", async () => {
    const article = await publishedArticle();
    const now = new Date("2026-10-20T10:15:00Z");
    await Promise.all(Array.from({ length: 20 }, () => impact.recordArticleView(article._id, now)));
    await impact.recordArticleView(article._id, new Date("2026-10-21T00:00:00Z"));
    const stored = await Article.findById(article._id).lean();
    assert.equal(stored.views.length, 2);
    assert.equal(stored.views[0].count, 20);
    assert.equal(stored.views[0].minuteCounts["615"], 20);
    assert.equal(stored.totalViews, 21);
    assert.equal(stored.updatedAt.getTime(), article.updatedAt.getTime());

    const draft = await articleService.createDraft(reporter);
    await impact.recordArticleView(draft._id, now);
    assert.equal((await Article.findById(draft._id).lean()).views.length, 0, "a non-public article is not counted");

    const range = impact.parseRange({ from: "2026-10-20T00:00Z", to: "2026-10-22T00:00Z" });
    const result = await impact.getImpact(stored, range);
    assert.deepEqual(result.points.map((point) => point.views), [20, 1]);

    const deleted = await impact.deleteViewStatistics(stored, editor, impact.parseDeleteRange({
      confirm: true, from: "2026-10-20T00:00:00.000Z", to: "2026-10-21T00:00:00.000Z",
    }));
    assert.deepEqual(deleted, { deletedViews: 20, deletedBuckets: 1, totalViews: 1 });
    const after = await Article.findById(article._id).lean();
    assert.equal(after.totalViews, 1);
    assert.equal(after.views.length, 1);
    assert.equal(after.publishEvents.length, 1, "publish markers are kept");
  });
});
