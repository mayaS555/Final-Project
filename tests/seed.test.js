// Tests for scripts/seed.js (owned by B). The generated documents are checked without a database; the
// "with MongoDB" part inserts them, compares them with an article made by the real workflow service, and runs
// C's public queries on them. It needs MONGODB_TEST_URI (see tests/testDatabase.js).
// Run: node --test tests/

const { describe, test, before, after, mock } = require("node:test");
const assert = require("assert");
const path = require("path");
const { spawnSync } = require("child_process");
const mongoose = require("mongoose");
const Article = require("../models/Article");
const { ARTICLE_CATEGORIES } = require("../models/articleCategories");
const articleService = require("../services/articleService");
const publicArticleService = require("../services/publicArticleService");
const { buildSeedArticles, REPORTERS, ARTICLE_COUNT, MULTI_UPDATE_COUNT } = require("../scripts/seed");
const { skipWithoutDatabase, connectTestDatabase, disconnectTestDatabase } = require("./testDatabase");

const NOW = new Date("2026-10-19T12:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const articles = buildSeedArticles({ now: NOW });

/**
 * The kind of a seeded article: its status, or "revision" for a pending new version of a published article.
 * @param {Object} article A seeded document.
 * @returns {string} "published", "pending", "revision", "draft" or "returned".
 * @example kindOf(article)
 */
function kindOf(article) {
  return article.status === "pending" && article.approved ? "revision" : article.status;
}

/**
 * Counts items by a key.
 * @param {Array} items The items.
 * @param {Function} keyOf Returns the key of an item.
 * @returns {Object} { key: count }.
 * @example countBy(articles, kindOf)
 */
function countBy(items, keyOf) {
  const counts = {};
  for (const item of items) {
    counts[keyOf(item)] = (counts[keyOf(item)] || 0) + 1;
  }
  return counts;
}

describe("seed documents (no MongoDB needed)", () => {
  test(`builds ${ARTICLE_COUNT} articles with the planned mix of states`, () => {
    assert.equal(articles.length, 500);
    assert.deepEqual(countBy(articles, kindOf), { published: 275, pending: 75, revision: 50, draft: 50, returned: 50 });
  });

  test("every document passes the model's validation", async () => {
    for (const article of articles) {
      await new Article(article).validate();
    }
  });

  test("every category has articles of every reporter and of every state", () => {
    for (const category of ARTICLE_CATEGORIES) {
      const inCategory = articles.filter(
        (article) => article.draft.category === category || (article.approved && article.approved.category === category)
      );
      assert.deepEqual(new Set(inCategory.map((article) => article.authorName)).size, REPORTERS.length, category);
      assert.ok(inCategory.some((article) => article.status === "published"), `${category} published`);
    }
    assert.deepEqual(Object.keys(countBy(articles, (article) => article.authorName)).sort(), REPORTERS.map((r) => r.name).sort());
  });

  test("a published article looks like approve() leaves it: working copy equals the public version", () => {
    for (const article of articles.filter((item) => item.status === "published")) {
      for (const field of ["title", "summary", "content", "imageUrl", "category"]) {
        assert.equal(article.draft[field], article.approved[field], field);
      }
      assert.equal(article.approved.authorName, article.authorName);
      assert.ok(article.publishCount >= 1);
    }
  });

  test("a pending revision keeps the old public version and has a newer working copy", () => {
    for (const article of articles.filter((item) => kindOf(item) === "revision")) {
      assert.notEqual(article.draft.title, article.approved.title);
      assert.ok(article.updatedAt > article.approved.updatedAt);
    }
  });

  test("never-published articles have no public version; returned ones have an editor note", () => {
    for (const article of articles.filter((item) => ["draft", "returned"].includes(item.status) || kindOf(item) === "pending")) {
      assert.equal(article.approved, undefined);
      assert.equal(article.publishCount, 0);
      assert.equal(Boolean(article.editorNote), article.status === "returned");
    }
  });

  test("published dates are spread over the last 60 days, and nothing is in the future", () => {
    const published = articles.filter((article) => article.approved);
    const days = published.map((article) => (NOW - article.approved.publishedAt) / DAY_MS);
    assert.ok(Math.min(...days) >= 1 && Math.max(...days) <= 61);
    assert.ok(Math.max(...days) - Math.min(...days) > 50, "spread over most of the 60 days");
    for (const article of articles) {
      assert.ok(article.createdAt <= article.updatedAt && article.updatedAt <= NOW, String(article._id));
    }
  });

  test(`${MULTI_UPDATE_COUNT} articles were approved 2-5 times, the last approval after the first`, () => {
    const multi = articles.filter((article) => article.publishCount >= 2);
    assert.ok(multi.length >= 10);
    assert.equal(multi.length, MULTI_UPDATE_COUNT);
    for (const article of multi) {
      assert.ok(article.publishCount <= 5);
      assert.equal(article.status, "published");
      assert.ok(article.approved.updatedAt > article.approved.publishedAt);
      assert.equal(article.updatedAt.getTime(), article.approved.updatedAt.getTime());
    }
  });

  test("no views, no image addresses (C's placeholder), and the same seed gives the same articles", () => {
    assert.ok(articles.every((article) => article.totalViews === 0 && article.draft.imageUrl === ""));
    const again = buildSeedArticles({ now: NOW });
    assert.deepEqual(again.map((article) => article.draft.title), articles.map((article) => article.draft.title));
  });

  test("refuses to run with NODE_ENV=production, before connecting", () => {
    const result = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "seed.js")], {
      env: { ...process.env, NODE_ENV: "production", MONGODB_URI: "mongodb://127.0.0.1:1/never-used" },
      encoding: "utf8",
      timeout: 20000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Refusing to seed: NODE_ENV is production/);
  });
});

describe("seed documents with MongoDB", { skip: skipWithoutDatabase }, () => {
  before(async () => {
    await connectTestDatabase();
    publicArticleService.useArticleModel(Article);
    await Article.insertMany(buildSeedArticles(), { timestamps: false });
  });

  after(disconnectTestDatabase);

  test("all 500 are stored with the dates the seed set", async () => {
    assert.equal(await Article.countDocuments(), 500);
    const multi = await Article.findOne({ publishCount: { $gte: 2 } }).lean();
    assert.ok(multi.approved.updatedAt > multi.approved.publishedAt);
    assert.ok(multi.createdAt < multi.approved.publishedAt);
  });

  test("a seeded published article has the same fields as one published by the real service", async () => {
    mock.method(console, "log", () => {});
    const reporter = { _id: new mongoose.Types.ObjectId(), role: "reporter", name: "Real" };
    const editor = { _id: new mongoose.Types.ObjectId(), role: "editor", name: "Ed" };
    let real = await articleService.createDraft(reporter);
    real = await articleService.saveWorkingCopy(real, reporter, { title: "T", summary: "S", content: "C", category: "Sports", imageUrl: "" });
    real = (await articleService.approve(await articleService.submit(real, reporter), editor)).article;
    mock.restoreAll();

    const realDocument = await Article.findById(real._id).lean();
    const seeded = await Article.findOne({ status: "published", publishCount: 1, _id: { $ne: real._id } }).lean();
    const fieldsOf = (document) => ({
      top: Object.keys(document).sort(),
      draft: Object.keys(document.draft).sort(),
      approved: Object.keys(document.approved).sort(),
    });
    assert.deepEqual(fieldsOf(seeded), fieldsOf(realDocument));
    await Article.deleteOne({ _id: real._id });
  });

  test("C's public site sees exactly the articles with an approved version", async () => {
    const publicCount = await Article.countDocuments(Article.publicFilter());
    assert.equal(publicCount, 275 + 50);
    const feed = await publicArticleService.getPublishedArticles({ page: 1 });
    assert.equal(feed.items.length, 20);
    assert.equal(feed.hasMore, true);
    assert.deepEqual((await publicArticleService.getPublishedCategories()).sort(), [...ARTICLE_CATEGORIES].sort());
  });

  test("title search works on the seeded titles", async () => {
    const results = await publicArticleService.getPublishedArticles({ page: 1, q: "harbor" });
    assert.ok(results.items.length > 0);
    assert.ok(results.items.every((item) => /harbor/i.test(item.title)));
  });

  test("a pending revision is public with its old title only", async () => {
    const revision = await Article.findOne({ status: "pending", ...Article.publicFilter() }).lean();
    const page = await publicArticleService.getPublishedArticleById(String(revision._id));
    assert.equal(page.title, revision.approved.title);
    assert.notEqual(page.title, revision.draft.title);
  });
});
