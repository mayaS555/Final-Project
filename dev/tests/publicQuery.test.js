// DEVELOPMENT ONLY. Checks the shape of the queries that publicArticleService builds, using a
// stand-in model that only records its calls. This does NOT run MongoDB: it cannot prove
// search results. See publicDb.test.js for that.
// Run with: node --test dev/tests/publicQuery.test.js

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert");
const service = require("../../services/publicArticleService");

const approvedOnly = { "approved.publishedAt": { $type: "date" } };

function createRecordingModel() {
  const calls = [];
  return {
    calls,
    find(filter, projection) {
      const call = { filter, projection };
      calls.push(call);
      const query = {
        sort(value) {
          call.sort = value;
          return query;
        },
        skip(value) {
          call.skip = value;
          return query;
        },
        limit(value) {
          call.limit = value;
          return query;
        },
        async lean() {
          return [];
        },
      };
      return query;
    },
    async distinct(field, filter) {
      calls.push({ field, filter });
      return ["Zeta", "Alpha", null, "", 5, "Markets"];
    },
  };
}

describe("publicArticleService query construction", () => {
  let model;

  beforeEach(() => {
    model = createRecordingModel();
    service.useArticleModel(model);
  });

  it("without filters only the approved-version filter is used", async () => {
    await service.getPublishedArticles({ page: 1 });
    assert.deepStrictEqual(model.calls[0].filter, approvedOnly);
  });

  it("empty q and category mean no filter", async () => {
    await service.getPublishedArticles({ page: 1, q: "", category: "" });
    assert.deepStrictEqual(model.calls[0].filter, approvedOnly);
  });

  it("q adds a text search", async () => {
    await service.getPublishedArticles({ page: 1, q: "harbor" });
    assert.deepStrictEqual(model.calls[0].filter, { ...approvedOnly, $text: { $search: "harbor" } });
  });

  it("category adds an exact match on the approved category", async () => {
    await service.getPublishedArticles({ page: 1, category: "Markets" });
    assert.deepStrictEqual(model.calls[0].filter, { ...approvedOnly, "approved.category": "Markets" });
  });

  it("q and category are combined in one filter", async () => {
    await service.getPublishedArticles({ page: 1, q: "harbor", category: "Markets" });
    assert.deepStrictEqual(model.calls[0].filter, {
      ...approvedOnly,
      $text: { $search: "harbor" },
      "approved.category": "Markets",
    });
  });

  it("the filter, the sort and the pagination belong to the same database query", async () => {
    await service.getPublishedArticles({ page: 3, q: "harbor", category: "Markets" });
    const call = model.calls[0];
    assert.ok(call.filter.$text);
    assert.strictEqual(call.skip, 40);
    assert.strictEqual(call.limit, 21);
    assert.deepStrictEqual(call.sort, { "approved.publishedAt": -1, _id: -1 });
  });

  describe("sort", () => {
    const dateSort = { "approved.publishedAt": -1, _id: -1 };
    const popularSort = { totalViews: -1, "approved.publishedAt": -1, _id: -1 };

    it("date is the default and sorts by publication date, then by id", async () => {
      await service.getPublishedArticles({ page: 1 });
      await service.getPublishedArticles({ page: 1, sort: "date" });
      assert.deepStrictEqual(model.calls[0].sort, dateSort);
      assert.deepStrictEqual(model.calls[1].sort, dateSort);
    });

    it("popular sorts by views, then by publication date, then by id", async () => {
      await service.getPublishedArticles({ page: 1, sort: "popular" });
      assert.deepStrictEqual(model.calls[0].sort, popularSort);
      assert.deepStrictEqual(Object.keys(model.calls[0].sort), ["totalViews", "approved.publishedAt", "_id"]);
    });

    it("sorting is part of the same database query as the filters and the pagination", async () => {
      await service.getPublishedArticles({ page: 3, q: "harbor", category: "Markets", viewed: "unviewed", sort: "popular", readArticleIds: ["64b7f0f2a1b2c3d4e5f60001"] });
      const call = model.calls[0];
      assert.deepStrictEqual(call.filter, {
        ...approvedOnly,
        $text: { $search: "harbor" },
        "approved.category": "Markets",
        _id: { $nin: ["64b7f0f2a1b2c3d4e5f60001"] },
      });
      assert.deepStrictEqual(call.sort, popularSort);
      assert.strictEqual(call.skip, 40);
      assert.strictEqual(call.limit, 21);
      assert.strictEqual(model.calls.length, 1);
    });

    it("sorting never adds a condition on views to the filter, so it cannot hide an article", async () => {
      await service.getPublishedArticles({ page: 1, sort: "popular" });
      assert.deepStrictEqual(model.calls[0].filter, approvedOnly);
    });

    it("an unknown sort is an error and no query runs", async () => {
      for (const sort of ["views", "POPULAR", "", "constructor", "__proto__", "toString"]) {
        await assert.rejects(() => service.getPublishedArticles({ page: 1, sort }), /Unknown sort/, sort);
      }
      assert.strictEqual(model.calls.length, 0);
    });

    it("the feed projection does not ask for the view count", async () => {
      await service.getPublishedArticles({ page: 1, sort: "popular" });
      assert.ok(!("totalViews" in model.calls[0].projection));
    });
  });

  it("never filters on pending data, status, summary or content", async () => {
    await service.getPublishedArticles({ page: 1, q: "harbor", category: "Markets" });
    const filterText = JSON.stringify(model.calls[0].filter);
    for (const forbidden of ["pending", "status", "summary", "content"]) {
      assert.ok(!filterText.includes(forbidden), forbidden);
    }
  });

  it("operator-looking input stays a plain search string", async () => {
    await service.getPublishedArticles({ page: 1, q: '{"$ne":1}', category: "$gt" });
    assert.deepStrictEqual(model.calls[0].filter, {
      ...approvedOnly,
      $text: { $search: '{"$ne":1}' },
      "approved.category": "$gt",
    });
  });

  describe("viewed filter", () => {
    const readIds = ["64b7f0f2a1b2c3d4e5f60001", "64b7f0f2a1b2c3d4e5f60002"];

    it("viewed=all ignores the history and adds no id filter", async () => {
      await service.getPublishedArticles({ page: 1, viewed: "all", readArticleIds: readIds });
      assert.deepStrictEqual(model.calls[0].filter, approvedOnly);
    });

    it("viewed keeps only the read ids and unviewed excludes them", async () => {
      await service.getPublishedArticles({ page: 1, viewed: "viewed", readArticleIds: readIds });
      await service.getPublishedArticles({ page: 1, viewed: "unviewed", readArticleIds: readIds });
      assert.deepStrictEqual(model.calls[0].filter, { ...approvedOnly, _id: { $in: readIds } });
      assert.deepStrictEqual(model.calls[1].filter, { ...approvedOnly, _id: { $nin: readIds } });
    });

    it("an empty history means nothing is viewed and everything is unviewed", async () => {
      await service.getPublishedArticles({ page: 1, viewed: "viewed", readArticleIds: [] });
      await service.getPublishedArticles({ page: 1, viewed: "unviewed", readArticleIds: [] });
      assert.deepStrictEqual(model.calls[0].filter._id, { $in: [] });
      assert.deepStrictEqual(model.calls[1].filter._id, { $nin: [] });
    });

    it("viewed is combined with search and category in the same database query, before pagination", async () => {
      await service.getPublishedArticles({ page: 2, q: "harbor", category: "Markets", viewed: "unviewed", readArticleIds: readIds });
      const call = model.calls[0];
      assert.deepStrictEqual(call.filter, {
        ...approvedOnly,
        $text: { $search: "harbor" },
        "approved.category": "Markets",
        _id: { $nin: readIds },
      });
      assert.strictEqual(call.skip, 20);
      assert.strictEqual(call.limit, 21);
      assert.deepStrictEqual(call.sort, { "approved.publishedAt": -1, _id: -1 });
    });

    it("the approved-only condition stays in every viewed query", async () => {
      await service.getPublishedArticles({ page: 1, viewed: "viewed", readArticleIds: readIds });
      assert.deepStrictEqual(model.calls[0].filter["approved.publishedAt"], { $type: "date" });
    });

    it("a viewed filter without a history list is an error, not an unfiltered feed", async () => {
      await assert.rejects(() => service.getPublishedArticles({ page: 1, viewed: "viewed" }), /list of read article ids/);
      await assert.rejects(() => service.getPublishedArticles({ page: 1, viewed: "unviewed", readArticleIds: "abc" }), /list of read article ids/);
      assert.strictEqual(model.calls.length, 0);
    });

    it("an unknown viewed value is an error", async () => {
      await assert.rejects(() => service.getPublishedArticles({ page: 1, viewed: "everything", readArticleIds: [] }), /Unknown viewed filter/);
      assert.strictEqual(model.calls.length, 0);
    });
  });

  it("categories come from the approved versions only, sorted, without junk values", async () => {
    const categories = await service.getPublishedCategories();
    assert.deepStrictEqual(model.calls[0], { field: "approved.category", filter: approvedOnly });
    assert.deepStrictEqual(categories, ["Alpha", "Markets", "Zeta"]);
  });
});
