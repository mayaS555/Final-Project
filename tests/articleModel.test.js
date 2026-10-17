// Tests for models/Article.js and models/articleCategories.js (owned by B).
// Validation and indexes are checked without a database. The "with MongoDB" part also runs C's
// publicArticleService against the real model; it needs MONGODB_TEST_URI (see tests/testDatabase.js).
// Run: node --test tests/

const { describe, test, before, after } = require("node:test");
const assert = require("assert");
const mongoose = require("mongoose");
const Article = require("../models/Article");
const { ARTICLE_STATUSES } = require("../models/Article");
const { ARTICLE_CATEGORIES } = require("../models/articleCategories");
const publicArticleService = require("../services/publicArticleService");
const { skipWithoutDatabase, connectTestDatabase, disconnectTestDatabase } = require("./testDatabase");

const authorId = new mongoose.Types.ObjectId();

/**
 * Builds an unsaved article with the required fields filled in.
 * @param {Object} [overrides] Fields to set or replace.
 * @returns {Object} A new Article document (not saved).
 * @example buildArticle({ status: "pending" })
 */
function buildArticle(overrides = {}) {
  return new Article({ author: authorId, authorName: "Noa", ...overrides });
}

/**
 * Builds a valid approved (public) version.
 * @param {Object} [overrides] Fields to set or replace.
 * @returns {Object} A plain object for the `approved` field.
 * @example buildArticle({ approved: approvedVersion({ title: "Harbor report" }) })
 */
function approvedVersion(overrides = {}) {
  const now = new Date();
  return {
    title: "Title",
    summary: "Summary",
    content: "First\n\nSecond",
    imageUrl: "",
    category: "Sports",
    authorName: "Noa",
    publishedAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/**
 * Returns the paths that fail validation.
 * @param {Object} article An Article document.
 * @returns {string[]} The invalid paths, empty when the document is valid.
 * @example invalidPaths(buildArticle({ status: "live" })) // ["status"]
 */
function invalidPaths(article) {
  const error = article.validateSync();
  return error ? Object.keys(error.errors) : [];
}

describe("articleCategories", () => {
  test("is a non-empty list of unique names that includes C's fallback General", () => {
    assert.ok(ARTICLE_CATEGORIES.length > 0);
    assert.equal(new Set(ARTICLE_CATEGORIES).size, ARTICLE_CATEGORIES.length);
    assert.ok(ARTICLE_CATEGORIES.includes("General"));
  });
});

describe("Article defaults", () => {
  test("a new article is an empty draft with no public version", () => {
    const article = buildArticle();
    assert.deepEqual(invalidPaths(article), []);
    assert.equal(article.status, "draft");
    assert.equal(article.approved, undefined);
    assert.equal(article.editorNote, "");
    assert.equal(article.publishCount, 0);
    assert.equal(article.totalViews, 0);
    for (const field of ["title", "summary", "content", "imageUrl", "category"]) {
      assert.equal(article.draft[field], "", field);
    }
  });

  test("the statuses are the four workflow states", () => {
    assert.deepEqual(ARTICLE_STATUSES, ["draft", "pending", "returned", "published"]);
  });
});

describe("Article validation", () => {
  test("author and authorName are required", () => {
    const paths = invalidPaths(new Article({}));
    assert.ok(paths.includes("author"));
    assert.ok(paths.includes("authorName"));
  });

  test("status must be one of the four states", () => {
    assert.deepEqual(invalidPaths(buildArticle({ status: "live" })), ["status"]);
    for (const status of ARTICLE_STATUSES) {
      assert.deepEqual(invalidPaths(buildArticle({ status })), [], status);
    }
  });

  test("a draft category is empty or from the list", () => {
    assert.deepEqual(invalidPaths(buildArticle({ draft: { category: "" } })), []);
    assert.deepEqual(invalidPaths(buildArticle({ draft: { category: "Sports" } })), []);
    assert.deepEqual(invalidPaths(buildArticle({ draft: { category: "Gossip" } })), ["draft.category"]);
  });

  test("an approved version needs a listed category, authorName, publishedAt and updatedAt", () => {
    assert.deepEqual(invalidPaths(buildArticle({ approved: approvedVersion() })), []);
    assert.deepEqual(invalidPaths(buildArticle({ approved: approvedVersion({ category: "" }) })), ["approved.category"]);
    assert.deepEqual(invalidPaths(buildArticle({ approved: approvedVersion({ category: "Gossip" }) })), ["approved.category"]);
    const missing = invalidPaths(
      buildArticle({ approved: approvedVersion({ authorName: undefined, publishedAt: undefined, updatedAt: undefined }) })
    );
    assert.deepEqual(missing.sort(), ["approved.authorName", "approved.publishedAt", "approved.updatedAt"]);
  });

  test("text fields have length limits", () => {
    assert.deepEqual(invalidPaths(buildArticle({ draft: { title: "x".repeat(200) } })), []);
    assert.deepEqual(invalidPaths(buildArticle({ draft: { title: "x".repeat(201) } })), ["draft.title"]);
    assert.deepEqual(invalidPaths(buildArticle({ draft: { summary: "x".repeat(501) } })), ["draft.summary"]);
    assert.deepEqual(invalidPaths(buildArticle({ draft: { content: "x".repeat(50001) } })), ["draft.content"]);
    assert.deepEqual(invalidPaths(buildArticle({ draft: { imageUrl: "x".repeat(2049) } })), ["draft.imageUrl"]);
    assert.deepEqual(invalidPaths(buildArticle({ editorNote: "x".repeat(1001) })), ["editorNote"]);
  });

  test("counters cannot be negative", () => {
    assert.deepEqual(invalidPaths(buildArticle({ publishCount: -1 })), ["publishCount"]);
    assert.deepEqual(invalidPaths(buildArticle({ totalViews: -1 })), ["totalViews"]);
  });

  test("title, summary and imageUrl are trimmed", () => {
    const article = buildArticle({ draft: { title: "  Storm  ", summary: " s ", imageUrl: " /a.png " } });
    assert.equal(article.draft.title, "Storm");
    assert.equal(article.draft.summary, "s");
    assert.equal(article.draft.imageUrl, "/a.png");
  });
});

describe("Article.publicFilter", () => {
  test("matches articles whose approved.publishedAt is a date", () => {
    assert.deepEqual(Article.publicFilter(), { "approved.publishedAt": { $type: "date" } });
  });

  test("returns a new object each call, so callers can extend it safely", () => {
    const filter = Article.publicFilter();
    filter._id = "changed";
    assert.equal(Article.publicFilter()._id, undefined);
  });
});

describe("Article indexes", () => {
  const declared = Article.schema.indexes().map(([fields, options]) => ({ fields, options }));

  /**
   * Finds a declared index by its fields.
   * @param {Object} fields The index keys, in order.
   * @returns {Object|undefined} { fields, options } or undefined.
   * @example findIndex({ author: 1, updatedAt: -1 })
   */
  function findIndex(fields) {
    return declared.find((index) => JSON.stringify(index.fields) === JSON.stringify(fields));
  }

  test("has the feed, category and dashboard indexes", () => {
    assert.ok(findIndex({ "approved.publishedAt": -1, _id: -1 }));
    assert.ok(findIndex({ "approved.category": 1, "approved.publishedAt": -1, _id: -1 }));
    assert.ok(findIndex({ author: 1, updatedAt: -1 }));
    assert.ok(findIndex({ status: 1, updatedAt: -1 }));
  });

  test("has one English text index, on the public title", () => {
    const textIndexes = declared.filter((index) => Object.values(index.fields).includes("text"));
    assert.equal(textIndexes.length, 1);
    assert.deepEqual(textIndexes[0].fields, { "approved.title": "text" });
    assert.equal(textIndexes[0].options.default_language, "english");
  });
});

describe("Article with MongoDB and C's public site", { skip: skipWithoutDatabase }, () => {
  let draftOnly;
  let published;
  let withRevision;

  before(async () => {
    await connectTestDatabase();
    publicArticleService.useArticleModel(Article);
    draftOnly = await Article.create({ author: authorId, authorName: "Noa", draft: { title: "Secret harbor plan" } });
    published = await Article.create({
      author: authorId,
      authorName: "Noa",
      status: "published",
      approved: approvedVersion({ title: "Harbor report", category: "Sports" }),
    });
    withRevision = await Article.create({
      author: authorId,
      authorName: "Noa",
      status: "pending",
      draft: { title: "Library news changed", category: "Culture" },
      approved: approvedVersion({ title: "Library news", category: "Culture" }),
    });
  });

  after(disconnectTestDatabase);

  test("all declared indexes exist in the database", async () => {
    const keys = (await Article.collection.indexes()).map((index) => index.key);
    assert.equal(keys.length, Article.schema.indexes().length + 1); // + _id
    assert.ok(keys.some((key) => key._fts === "text"));
  });

  test("publicFilter counts only articles with an approved version", async () => {
    assert.equal(await Article.countDocuments(Article.publicFilter()), 2);
  });

  test("the feed shows approved versions only", async () => {
    const feed = await publicArticleService.getPublishedArticles({ page: 1 });
    assert.deepEqual(feed.items.map((item) => item.title).sort(), ["Harbor report", "Library news"]);
  });

  test("title search uses the approved title only", async () => {
    const harbor = await publicArticleService.getPublishedArticles({ page: 1, q: "harbor" });
    assert.deepEqual(harbor.items.map((item) => item.id), [String(published._id)]);
    const changed = await publicArticleService.getPublishedArticles({ page: 1, q: "changed" });
    assert.equal(changed.items.length, 0);
  });

  test("category filter, category list and popular sort work", async () => {
    const sports = await publicArticleService.getPublishedArticles({ page: 1, category: "Sports" });
    assert.equal(sports.items.length, 1);
    assert.deepEqual(await publicArticleService.getPublishedCategories(), ["Culture", "Sports"]);
    const popular = await publicArticleService.getPublishedArticles({ page: 1, sort: "popular" });
    assert.equal(popular.items.length, 2);
  });

  test("the article page hides draft-only articles and shows the approved text", async () => {
    assert.equal(await publicArticleService.getPublishedArticleById(String(draftOnly._id)), null);
    const page = await publicArticleService.getPublishedArticleById(String(withRevision._id));
    assert.equal(page.title, "Library news");
    assert.equal(page.content, "First\n\nSecond");
    assert.equal(page.authorName, "Noa");
  });
});
