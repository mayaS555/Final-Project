// DEVELOPMENT ONLY. Checks that need no MongoDB: input validation, template escaping,
// and error responses. These do NOT prove the database queries; see publicDb.test.js.
// Run with: node --test dev/tests/publicNoDb.test.js

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const ejs = require("ejs");
const createDevApp = require("../createDevApp");
const { parseFeedQuery, buildFeedHref } = require("../../controllers/publicController");
const { toSafeImageUrl } = require("../../services/publicArticleService");
const { DEV_DATABASE_NAME } = require("../connectDevDb");
const { seedDevArticles, assertModelTargetsDevCollection, DEV_COLLECTION_NAME } = require("../seed-public");

const viewsDir = path.join(__dirname, "..", "..", "views", "public");

describe("public site without a database", () => {
  let server;
  let baseUrl;
  const originalConsoleError = console.error;

  before(async () => {
    // No article model is connected on purpose, so database-backed requests must fail safely.
    server = createDevApp().listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    console.error = () => {};
  });

  after(() => {
    console.error = originalConsoleError;
    server.close();
  });

  for (const badPage of ["0", "-1", "abc", "1.5", "1001", "99999999", "", "1e9"]) {
    it(`API rejects page="${badPage}" with 400`, async () => {
      const response = await fetch(`${baseUrl}/api/public/articles?page=${encodeURIComponent(badPage)}`);
      assert.strictEqual(response.status, 400);
      const body = await response.json();
      assert.match(body.error, /page must be/);
    });
  }

  it("API rejects a repeated page parameter with 400", async () => {
    const response = await fetch(`${baseUrl}/api/public/articles?page=1&page=2`);
    assert.strictEqual(response.status, 400);
  });

  it("home page rejects an invalid page with 400", async () => {
    const response = await fetch(`${baseUrl}/?page=abc`);
    assert.strictEqual(response.status, 400);
  });

  const structuredQueries = ["q[$ne]=x", "q[]=a", "category[$gt]=", "category[a][b]=1", "page[a]=1", "page[]=1"];

  for (const queryString of structuredQueries) {
    it(`API and home page reject the structured parameter ${queryString} with 400`, async () => {
      const apiResponse = await fetch(`${baseUrl}/api/public/articles?${queryString}`);
      assert.strictEqual(apiResponse.status, 400);
      assert.match((await apiResponse.json()).error, /structured/);

      const pageResponse = await fetch(`${baseUrl}/?${queryString}`);
      assert.strictEqual(pageResponse.status, 400);
      assert.match(await pageResponse.text(), /structured/);
    });
  }

  it("unrelated unknown parameters, even structured ones, are ignored", async () => {
    // No model is connected here, so a request that passes validation ends in the generic 500.
    for (const queryString of ["unknown=1", "unknown[a]=1", "$where=1&status=draft", "query[x]=1"]) {
      assert.strictEqual((await fetch(`${baseUrl}/api/public/articles?${queryString}`)).status, 500, queryString);
      assert.strictEqual((await fetch(`${baseUrl}/?${queryString}`)).status, 500, queryString);
    }
  });

  const badFilterQueries = {
    "a repeated q": "q=a&q=b",
    "a repeated category": "category=a&category=b",
    "a q longer than 100 characters": `q=${"a".repeat(101)}`,
    "a category longer than 50 characters": `category=${"a".repeat(51)}`,
    "a newline inside q": "q=a%0Ab",
    "a null character inside category": "category=a%00b",
    "a DEL character in q": "q=%7F",
  };

  for (const [label, queryString] of Object.entries(badFilterQueries)) {
    it(`API and home page reject ${label} with 400`, async () => {
      const apiResponse = await fetch(`${baseUrl}/api/public/articles?${queryString}`);
      assert.strictEqual(apiResponse.status, 400);
      assert.match((await apiResponse.json()).error, /q must|category must|invalid characters/);

      const pageResponse = await fetch(`${baseUrl}/?${queryString}`);
      assert.strictEqual(pageResponse.status, 400);
    });
  }

  it("malformed article ids give 404 without touching the database", async () => {
    for (const id of ["not-an-id", "123", "zzzzzzzzzzzzzzzzzzzzzzzz", "%24ne"]) {
      const response = await fetch(`${baseUrl}/articles/${id}`);
      assert.strictEqual(response.status, 404, `id ${id}`);
    }
  });

  it("an unexpected failure returns a generic 500 without internal details", async () => {
    const apiResponse = await fetch(`${baseUrl}/api/public/articles`);
    assert.strictEqual(apiResponse.status, 500);
    const apiText = await apiResponse.text();
    assert.ok(!apiText.includes("publicArticleService"));
    assert.ok(!apiText.includes("at "));

    const pageResponse = await fetch(`${baseUrl}/`);
    assert.strictEqual(pageResponse.status, 500);
    const pageText = await pageResponse.text();
    assert.ok(pageText.includes('class="pub-site"'), "GET / is served by the EJS route, not public/index.html");
    assert.ok(!pageText.includes("publicArticleService"));
  });

  it("static assets and the old pages are still served", async () => {
    assert.strictEqual((await fetch(`${baseUrl}/css/public.css`)).status, 200);
    assert.strictEqual((await fetch(`${baseUrl}/index.html`)).status, 200);
    assert.strictEqual((await fetch(`${baseUrl}/login.html`)).status, 200);
  });
});

describe("templates", () => {
  const article = {
    id: "64b7f0f2a1b2c3d4e5f60718",
    title: "Title <b>bold</b>",
    summary: "Summary <i>x</i>",
    imageUrl: null,
    category: "Tech <u>",
    authorName: "Author <s>",
    publishedAt: "2026-10-01T10:00:00.000Z",
    content: "Body <script>alert(1)</script>",
  };
  const formatDate = () => "October 1, 2026";

  it("article page escapes user text and contains the full content", async () => {
    const html = await ejs.renderFile(path.join(viewsDir, "article.ejs"), {
      pageTitle: article.title,
      article,
      paragraphs: ["First paragraph", article.content],
      formatDate,
    });
    assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
    assert.ok(!html.includes("<script>"));
    assert.ok(!html.includes("<b>bold</b>"));
    assert.ok(html.includes("First paragraph"));
  });

  function renderHome({ items = [article], page = 1, hasMore = false, filters = { q: "", category: "" }, categories = [] } = {}) {
    return ejs.renderFile(path.join(viewsDir, "home.ejs"), {
      pageTitle: "The Daily Web",
      feed: { items, page, hasMore },
      categories,
      filters,
      feedHref: (targetPage) => buildFeedHref(filters, targetPage),
      formatDate,
    });
  }

  it("home page escapes user text", async () => {
    const html = await renderHome();
    assert.ok(!html.includes("<b>bold</b>"));
    assert.ok(html.includes("Title &lt;b&gt;bold&lt;/b&gt;"));
  });

  it("empty feed shows an empty state", async () => {
    const html = await renderHome({ items: [] });
    assert.ok(html.includes("No published articles yet."));
  });

  it("empty filtered feed says that nothing matches", async () => {
    const html = await renderHome({ items: [], filters: { q: "zzz", category: "" } });
    assert.ok(html.includes("No articles match your search or category."));
  });

  it("search form shows the active filters and escapes them", async () => {
    const html = await renderHome({
      filters: { q: '"><script>x</script>', category: "Markets" },
      categories: ["Business", "Markets"],
    });
    assert.ok(!html.includes("<script>x</script>"));
    assert.ok(html.includes("&#34;&gt;&lt;script&gt;x&lt;/script&gt;"));
    assert.ok(html.includes('<option value="Markets" selected>Markets</option>'));
    assert.ok(html.includes('<option value="Business">Business</option>'));
    assert.ok(html.includes('data-category="Markets"'));
  });

  it("an unlisted category from the URL stays selected as an escaped option", async () => {
    const html = await renderHome({
      items: [],
      filters: { q: "", category: 'No<b>Such' },
      categories: ["Business", "Markets"],
    });
    assert.ok(html.includes('<option value="No&lt;b&gt;Such" selected>No&lt;b&gt;Such</option>'));
    assert.ok(!html.includes("No<b>Such"));
    assert.strictEqual((html.match(/selected/g) || []).length, 1);
  });

  it("a listed category is not added a second time", async () => {
    const html = await renderHome({ filters: { q: "", category: "Markets" }, categories: ["Business", "Markets"] });
    assert.strictEqual((html.match(/value="Markets"/g) || []).length, 1);
  });

  it("no extra category option appears without a category filter", async () => {
    const html = await renderHome({ categories: ["Business", "Markets"] });
    assert.strictEqual((html.match(/<option /g) || []).length, 3);
  });

  it("pager links are marked so the script can hide only the older one", async () => {
    const html = await renderHome({ page: 2, hasMore: true });
    assert.ok(html.includes('data-pager="newer"'));
    assert.ok(html.includes('data-pager="older"'));
  });

  it("pager links keep the active filters", async () => {
    const html = await renderHome({ page: 2, hasMore: true, filters: { q: "harbor report", category: "Markets" } });
    assert.ok(html.includes('href="/?q=harbor+report&amp;category=Markets"'), "newer link goes back to page 1");
    assert.ok(html.includes('href="/?q=harbor+report&amp;category=Markets&amp;page=3"'), "older link");
    assert.ok(html.includes('data-next-page="3"'));
    assert.ok(html.includes('data-has-more="true"'));
  });
});

describe("parseFeedQuery and buildFeedHref", () => {
  it("returns defaults for an empty query", () => {
    assert.deepStrictEqual(parseFeedQuery({}), { page: 1, q: "", category: "" });
  });

  it("trims text and treats empty or blank values as no filter", () => {
    assert.deepStrictEqual(parseFeedQuery({ q: "  harbor  ", category: " Markets " }), { page: 1, q: "harbor", category: "Markets" });
    assert.deepStrictEqual(parseFeedQuery({ q: "", category: "   " }), { page: 1, q: "", category: "" });
  });

  it("accepts values exactly at the length limits", () => {
    const result = parseFeedQuery({ q: "a".repeat(100), category: "b".repeat(50), page: "1000" });
    assert.strictEqual(result.error, undefined);
    assert.strictEqual(result.page, 1000);
  });

  it("rejects arrays and objects where a string is expected", () => {
    assert.ok(parseFeedQuery({ q: ["a", "b"] }).error);
    assert.ok(parseFeedQuery({ category: ["a"] }).error);
    assert.ok(parseFeedQuery({ q: { $ne: "x" } }).error);
    assert.ok(parseFeedQuery({ category: { $gt: "" } }).error);
  });

  it("rejects structured forms of recognized parameters and names the parameter", () => {
    assert.match(parseFeedQuery({ "q[$ne]": "x" }).error, /^q must be a single value/);
    assert.match(parseFeedQuery({ "q[]": "a" }).error, /^q must/);
    assert.match(parseFeedQuery({ "category[$gt]": "" }).error, /^category must/);
    assert.match(parseFeedQuery({ "page[a]": "1" }).error, /^page must/);
  });

  it("ignores unrelated unknown parameters, including look-alike names", () => {
    assert.deepStrictEqual(parseFeedQuery({ "unknown[a]": "1", "query[x]": "1", "qq[a]": "1", q: "a" }), { page: 1, q: "a", category: "" });
  });

  it("returns only the known fields", () => {
    const result = parseFeedQuery({ q: "a", category: "b", page: "2", $where: "1", status: "draft" });
    assert.deepStrictEqual(Object.keys(result).sort(), ["category", "page", "q"]);
  });

  it("builds links that keep filters and drop empty ones", () => {
    assert.strictEqual(buildFeedHref({ q: "", category: "" }, 1), "/");
    assert.strictEqual(buildFeedHref({ q: "", category: "" }, 3), "/?page=3");
    assert.strictEqual(buildFeedHref({ q: "a&b=c", category: "Sci Fi" }, 2), "/?q=a%26b%3Dc&category=Sci+Fi&page=2");
  });
});

describe("toSafeImageUrl", () => {
  it("keeps http, https and site-relative paths", () => {
    assert.strictEqual(toSafeImageUrl("https://example.com/a.jpg"), "https://example.com/a.jpg");
    assert.strictEqual(toSafeImageUrl("http://example.com/a.jpg"), "http://example.com/a.jpg");
    assert.strictEqual(toSafeImageUrl("/images/a.jpg"), "/images/a.jpg");
  });

  it("drops unsafe or invalid values", () => {
    for (const value of ["javascript:alert(1)", "data:text/html,x", "//evil.example/a.jpg", "not a url", "", null, undefined, 42, "https://" + "a".repeat(3000)]) {
      assert.strictEqual(toSafeImageUrl(value), null, String(value).slice(0, 30));
    }
  });

  it("rejects local paths that a browser could read as //host", () => {
    const values = [
      "/\\evil.example/a.jpg",
      "/\\/evil.example/a.jpg",
      "/\n/evil.example/a.jpg",
      "/\nevil.example/a.jpg",
      "/\r/evil.example/a.jpg",
      "/\t/evil.example/a.jpg",
      "/\u0000/evil.example/a.jpg",
      "/images/a\\b.jpg",
    ];
    for (const value of values) {
      assert.strictEqual(toSafeImageUrl(value), null, JSON.stringify(value));
    }
  });

  it("rejects absolute URLs that contain control characters or backslashes", () => {
    for (const value of ["https://exa\nmple.com/a.jpg", "https://example.com/a\\b.jpg", "https:\\\\evil.example/a.jpg"]) {
      assert.strictEqual(toSafeImageUrl(value), null, JSON.stringify(value));
    }
  });

  it("still accepts ordinary local paths", () => {
    assert.strictEqual(toSafeImageUrl("/images/a.jpg"), "/images/a.jpg");
    assert.strictEqual(toSafeImageUrl("/img/photo-1.png?size=large"), "/img/photo-1.png?size=large");
  });
});

describe("seed safety guard", () => {
  // Stand-in model: records calls so the tests can prove nothing was written.
  function createFakeModel({ dbName, readyState, collectionName }) {
    const calls = [];
    const record = (name) => async () => {
      calls.push(name);
      return [];
    };
    return {
      calls,
      model: {
        db: { name: dbName, readyState },
        collection: { name: collectionName },
        deleteMany: record("deleteMany"),
        createIndexes: record("createIndexes"),
        insertMany: record("insertMany"),
      },
    };
  }

  const cases = [
    { label: "a different database", dbName: "production_news", readyState: 1, collectionName: DEV_COLLECTION_NAME, message: /production_news/ },
    { label: "a model with no database name", dbName: undefined, readyState: 1, collectionName: DEV_COLLECTION_NAME, message: /expected/ },
    { label: "a connection that is not open", dbName: DEV_DATABASE_NAME, readyState: 0, collectionName: DEV_COLLECTION_NAME, message: /not on an open/ },
    { label: "a connecting (not yet open) connection", dbName: DEV_DATABASE_NAME, readyState: 2, collectionName: DEV_COLLECTION_NAME, message: /not on an open/ },
    { label: "a different collection", dbName: DEV_DATABASE_NAME, readyState: 1, collectionName: "articles", message: /articles/ },
  ];

  for (const testCase of cases) {
    it(`throws and never calls deleteMany for ${testCase.label}`, async () => {
      const { model, calls } = createFakeModel(testCase);
      await assert.rejects(() => seedDevArticles(model), testCase.message);
      assert.deepStrictEqual(calls, []);
    });
  }

  it("accepts the dev database and the dev collection", () => {
    const { model } = createFakeModel({ dbName: DEV_DATABASE_NAME, readyState: 1, collectionName: DEV_COLLECTION_NAME });
    assert.doesNotThrow(() => assertModelTargetsDevCollection(model));
  });

  it("the real dev model is rejected while it has no open connection", async () => {
    // Without calling connectDevDb() the real model is not connected, so seeding must refuse.
    await assert.rejects(() => seedDevArticles(), /not on an open database connection/);
  });
});
