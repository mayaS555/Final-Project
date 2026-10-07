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

  it("categories come from the approved versions only, sorted, without junk values", async () => {
    const categories = await service.getPublishedCategories();
    assert.deepStrictEqual(model.calls[0], { field: "approved.category", filter: approvedOnly });
    assert.deepStrictEqual(categories, ["Alpha", "Markets", "Zeta"]);
  });
});
