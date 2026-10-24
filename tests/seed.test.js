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
const User = require("../models/User");
const { ARTICLE_CATEGORIES } = require("../models/articleCategories");
const articleService = require("../services/articleService");
const publicArticleService = require("../services/publicArticleService");
const {
  buildSeedArticles,
  buildSeedAnalytics,
  buildSeedComments,
  attachSeedData,
  createSeedUsers,
  REPORTERS,
  ARTICLE_COUNT,
  MULTI_UPDATE_COUNT,
} = require("../scripts/seed");
const { skipWithoutDatabase, connectTestDatabase, disconnectTestDatabase } = require("./testDatabase");

const NOW = new Date("2026-10-19T12:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const articles = buildSeedArticles({ now: NOW });
const analytics = buildSeedAnalytics({ articles, now: NOW });
const comments = buildSeedComments({ articles, now: NOW });

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

  test("every article has one of the seed images, and the same seed gives the same articles", () => {
    assert.ok(articles.every((article) => article.totalViews === 0 && /^\/images\/seed\/news-([1-9]|10)\.jpg$/.test(article.draft.imageUrl)));
    assert.ok(new Set(articles.map((article) => article.draft.imageUrl)).size === 10);
    const again = buildSeedArticles({ now: NOW });
    assert.deepEqual(again.map((article) => article.draft.title), articles.map((article) => article.draft.title));
  });

  test("articles can be assigned to the real ids of the users the seed creates", () => {
    const reporters = [
      { id: "665000000000000000000101", name: "First Reporter" },
      { id: "665000000000000000000102", name: "Second Reporter" },
    ];
    const generated = buildSeedArticles({ now: NOW, reporters });
    assert.ok(generated.every((article) => reporters.some((reporter) => reporter.id === String(article.author))));
    assert.deepEqual(new Set(generated.map((article) => article.authorName)).size, reporters.length);
  });

  test("comments are seeded on public articles, after publication and before now", () => {
    const articlesById = new Map(articles.map((article) => [String(article._id), article]));
    assert.ok(comments.length > 0);
    for (const comment of comments) {
      const article = articlesById.get(String(comment.articleId));
      assert.ok(article && article.approved, "comment belongs to a public article");
      assert.ok(comment.displayName && comment.body && comment.deviceId);
      assert.ok(comment.createdAt >= article.approved.publishedAt);
      assert.ok(comment.createdAt <= NOW);
    }
  });

  test("view data covers every public article and totalViews is the sum of its buckets", () => {
    const publicIds = new Set(articles.filter((article) => article.approved).map((article) => String(article._id)));
    const viewsByArticle = new Map();
    for (const view of analytics.views) {
      const id = String(view.articleId);
      assert.ok(publicIds.has(id), "only public articles have views");
      assert.ok(view.count >= 1);
      assert.ok(view.bucketStart <= NOW);
      viewsByArticle.set(id, (viewsByArticle.get(id) || 0) + view.count);
    }
    assert.equal(viewsByArticle.size, publicIds.size);
    for (const id of publicIds) {
      assert.equal(analytics.totalViews.get(id), viewsByArticle.get(id));
      assert.ok(analytics.totalViews.get(id) > 0);
    }
    assert.ok(!analytics.totalViews.has(String(articles.find((article) => !article.approved)._id)));
  });

  test("every approval has a publish marker between the first and last approval", () => {
    const eventsByArticle = new Map();
    for (const event of analytics.publishEvents) {
      const id = String(event.articleId);
      if (!eventsByArticle.has(id)) {
        eventsByArticle.set(id, []);
      }
      eventsByArticle.get(id).push(event);
    }
    for (const article of articles.filter((item) => item.approved)) {
      const events = eventsByArticle.get(String(article._id));
      assert.equal(events.length, article.publishCount);
      assert.equal(events[0].isFirstPublish, true);
      assert.equal(events[0].publishedAt.getTime(), article.approved.publishedAt.getTime());
      assert.equal(events.at(-1).publishedAt.getTime(), article.approved.updatedAt.getTime());
      assert.deepEqual(events.map((event) => event.publishCount), article.publishCount === 1 ? [1] : [1, 2, 3, 4, 5].slice(0, article.publishCount));
      assert.ok(events.every((event) => event.publishedAt >= article.approved.publishedAt && event.publishedAt <= article.approved.updatedAt));
    }
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
  let seededUsers;
  let seededArticles;
  let seededComments;
  let seededAnalytics;

  before(async () => {
    await connectTestDatabase();
    publicArticleService.useArticleModel(Article);
    await User.init();
    seededUsers = await createSeedUsers();
    const reporters = seededUsers.reporters.map((user) => ({ id: String(user._id), name: user.name }));
    seededArticles = buildSeedArticles({ reporters });
    seededAnalytics = buildSeedAnalytics({ articles: seededArticles });
    seededComments = buildSeedComments({ articles: seededArticles });
    attachSeedData({ articles: seededArticles, comments: seededComments, analytics: seededAnalytics });
    await Article.insertMany(seededArticles, { timestamps: false });
  });

  after(disconnectTestDatabase);

  test("all 500 are stored with the dates the seed set", async () => {
    assert.equal(await Article.countDocuments(), 500);
    const multi = await Article.findOne({ publishCount: { $gte: 2 } }).lean();
    assert.ok(multi.approved.updatedAt > multi.approved.publishedAt);
    assert.ok(multi.createdAt < multi.approved.publishedAt);
  });

  test("demo users are real accounts with hashed passwords and own the seeded articles", async () => {
    assert.equal(seededUsers.reporters.length, 5);
    assert.equal(seededUsers.editor.role, "editor");
    assert.deepEqual(seededUsers.reporters.map((user) => String(user._id)).sort(), REPORTERS.map((reporter) => reporter.id).sort());
    const reporterPassword = process.env.SEED_REPORTER_PASSWORD || "reporter123";
    const editorPassword = process.env.SEED_EDITOR_PASSWORD || "editor123";
    for (const user of seededUsers.reporters) {
      assert.match(user.password, /^\$2[aby]\$10\$/);
      assert.equal(await user.comparePassword(reporterPassword), true);
    }
    assert.match(seededUsers.editor.password, /^\$2[aby]\$10\$/);
    assert.equal(await seededUsers.editor.comparePassword(editorPassword), true);

    const usersById = new Map([...seededUsers.reporters, seededUsers.editor].map((user) => [String(user._id), user]));
    for (const article of seededArticles) {
      const author = usersById.get(String(article.author));
      assert.ok(author, "the article author is a real user");
      assert.equal(article.authorName, author.name);
    }
  });

  test("comments, views and publish events are stored inside public articles", async () => {
    const stored = await Article.find().select("+comments.deviceId").lean();
    const count = (field) => stored.reduce((sum, article) => sum + article[field].length, 0);
    assert.equal(count("comments"), seededComments.length);
    assert.equal(count("views"), seededAnalytics.views.length);
    assert.equal(count("publishEvents"), seededAnalytics.publishEvents.length);
    for (const article of stored) {
      if (!article.approved) {
        assert.equal(article.comments.length + article.views.length + article.publishEvents.length, 0);
        continue;
      }
      assert.ok(article.comments.every((comment) => comment._id && comment.deviceId && comment.createdAt));
      assert.ok(article.views.every((view) => view.count >= 1));
      assert.equal(article.views.reduce((sum, view) => sum + view.count, 0), article.totalViews);
      assert.equal(article.publishEvents.length, article.publishCount);
    }
    const storedUsers = await User.countDocuments();
    assert.equal(storedUsers, 6);
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
    /**
     * The field names of an article, at the top level and inside draft and approved.
     * @param {Object} document A lean article.
     * @returns {{ top: string[], draft: string[], approved: string[] }} Sorted field names.
     * @example fieldsOf(seeded)
     */
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
