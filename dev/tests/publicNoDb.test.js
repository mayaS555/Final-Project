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
const { seedDevArticles, assertModelTargetsDevCollection, DEV_COLLECTION_NAME, DEV_READ_COLLECTION_NAME, DEV_COMMENTS_COLLECTION_NAME } = require("../seed-public");
const { assertBenchTarget, BenchArticle, BENCH_COLLECTION_NAME } = require("../measure-feed-queries");
const { deviceIdentity, readDeviceIdCookie, DEVICE_COOKIE_NAME, DEVICE_COOKIE_MAX_AGE_MS } = require("../../middleware/deviceIdentity");

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

  const structuredQueries = ["q[$ne]=x", "q[]=a", "category[$gt]=", "category[a][b]=1", "page[a]=1", "page[]=1", "viewed[$ne]=x", "viewed[]=viewed"];

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
    "an unknown viewed value": "viewed=everything",
    "the old not-viewed spelling": "viewed=not-viewed",
    "a viewed value in capitals": "viewed=VIEWED",
    "a repeated viewed": "viewed=viewed&viewed=unviewed",
    "a viewed value with a control character": "viewed=all%0A",
    "a viewed value that is too long": `viewed=${"a".repeat(11)}`,
  };

  for (const [label, queryString] of Object.entries(badFilterQueries)) {
    it(`API and home page reject ${label} with 400`, async () => {
      const apiResponse = await fetch(`${baseUrl}/api/public/articles?${queryString}`);
      assert.strictEqual(apiResponse.status, 400);
      assert.match((await apiResponse.json()).error, /q must|category must|viewed must|invalid characters/);

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
      comments: { items: [], hasMore: false, nextBefore: null },
      commentsFailed: false,
      formatDate,
      formatDateTime: () => "Oct 1, 2026, 10:00 AM UTC",
    });
    assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
    assert.ok(!html.includes("<script>"));
    assert.ok(!html.includes("<b>bold</b>"));
    assert.ok(html.includes("First paragraph"));
  });

  function renderHome({ items = [article], page = 1, hasMore = false, filters = { q: "", category: "", viewed: "all" }, categories = [] } = {}) {
    return ejs.renderFile(path.join(viewsDir, "home.ejs"), {
      pageTitle: "The Daily Web",
      feed: { items, page, hasMore },
      categories,
      filters,
      feedHref: (targetPage) => buildFeedHref(filters, targetPage),
      formatDate,
    });
  }

  function categorySelect(html) {
    const match = html.match(/<select name="category"[\s\S]*?<\/select>/);
    assert.ok(match, "the category select is missing");
    return match[0];
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
    const html = await renderHome({ items: [], filters: { q: "zzz", category: "", viewed: "all" } });
    assert.ok(html.includes("No articles match your filters."));
  });

  it("search form shows the active filters and escapes them", async () => {
    const html = await renderHome({
      filters: { q: '"><script>x</script>', category: "Markets", viewed: "all" },
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
      filters: { q: "", category: 'No<b>Such', viewed: "all" },
      categories: ["Business", "Markets"],
    });
    assert.ok(html.includes('<option value="No&lt;b&gt;Such" selected>No&lt;b&gt;Such</option>'));
    assert.ok(!html.includes("No<b>Such"));
    assert.strictEqual((categorySelect(html).match(/selected/g) || []).length, 1);
  });

  it("a listed category is not added a second time", async () => {
    const html = await renderHome({ filters: { q: "", category: "Markets", viewed: "all" }, categories: ["Business", "Markets"] });
    assert.strictEqual((html.match(/value="Markets"/g) || []).length, 1);
  });

  it("no extra category option appears without a category filter", async () => {
    const html = await renderHome({ categories: ["Business", "Markets"] });
    assert.strictEqual((categorySelect(html).match(/<option /g) || []).length, 3);
  });

  function viewedSelect(html) {
    const match = html.match(/<select name="viewed"[\s\S]*?<\/select>/);
    assert.ok(match, "the viewed select is missing");
    return match[0];
  }

  it("the viewed select has three labelled options and All is selected by default", async () => {
    const select = viewedSelect(await renderHome());
    assert.ok(select.includes('aria-label="Filter by viewed state"'));
    assert.deepStrictEqual([...select.matchAll(/<option value="([a-z]+)"/g)].map((match) => match[1]), ["all", "viewed", "unviewed"]);
    assert.ok(select.includes('<option value="all" selected>'));
    assert.strictEqual((select.match(/selected/g) || []).length, 1);
  });

  it("the viewed select keeps the active choice and the feed element carries it", async () => {
    for (const viewed of ["viewed", "unviewed"]) {
      const html = await renderHome({ filters: { q: "", category: "", viewed } });
      assert.ok(viewedSelect(html).includes(`<option value="${viewed}" selected>`), viewed);
      assert.strictEqual((viewedSelect(html).match(/selected/g) || []).length, 1);
      assert.ok(html.includes(`data-viewed="${viewed}"`));
    }
  });

  it("an empty result with only a viewed filter says that nothing matches", async () => {
    const html = await renderHome({ items: [], filters: { q: "", category: "", viewed: "viewed" } });
    assert.ok(html.includes("No articles match your filters."));
  });

  it("pager links keep the viewed filter", async () => {
    const html = await renderHome({ page: 2, hasMore: true, filters: { q: "", category: "", viewed: "unviewed" } });
    assert.ok(html.includes('href="/?viewed=unviewed"'), "newer link");
    assert.ok(html.includes('href="/?viewed=unviewed&amp;page=3"'), "older link");
  });

  function sortSelect(html) {
    const match = html.match(/<select name="sort"[\s\S]*?<\/select>/);
    assert.ok(match, "the sort select is missing");
    return match[0];
  }

  it("the sort select has two labelled options and Newest first is selected by default", async () => {
    // These renders pass filters without a sort, like an older caller would.
    const html = await renderHome();
    const select = sortSelect(html);
    assert.ok(select.includes('aria-label="Sort articles"'));
    assert.deepStrictEqual([...select.matchAll(/<option value="([a-z]+)"/g)].map((match) => match[1]), ["date", "popular"]);
    assert.ok(select.includes('<option value="date" selected>Newest first</option>'));
    assert.ok(select.includes(">Most popular</option>"));
    assert.strictEqual((select.match(/selected/g) || []).length, 1);
    assert.ok(html.includes('data-sort="date"'));
  });

  it("the sort select keeps the popular choice and the feed element carries it", async () => {
    const html = await renderHome({ filters: { q: "", category: "", viewed: "all", sort: "popular" } });
    assert.ok(sortSelect(html).includes('<option value="popular" selected>Most popular</option>'));
    assert.strictEqual((sortSelect(html).match(/selected/g) || []).length, 1);
    assert.ok(html.includes('data-sort="popular"'));
  });

  it("pager links keep the popular sort and the sort alone does not count as a filter", async () => {
    const filters = { q: "", category: "", viewed: "all", sort: "popular" };
    const html = await renderHome({ page: 2, hasMore: true, filters });
    assert.ok(html.includes('href="/?sort=popular"'), "newer link");
    assert.ok(html.includes('href="/?sort=popular&amp;page=3"'), "older link");
    const empty = await renderHome({ items: [], filters });
    assert.ok(empty.includes("No published articles yet."));
  });

  it("pager links are marked so the script can hide only the older one", async () => {
    const html = await renderHome({ page: 2, hasMore: true });
    assert.ok(html.includes('data-pager="newer"'));
    assert.ok(html.includes('data-pager="older"'));
  });

  it("pager links keep the active filters", async () => {
    const html = await renderHome({ page: 2, hasMore: true, filters: { q: "harbor report", category: "Markets", viewed: "all" } });
    assert.ok(html.includes('href="/?q=harbor+report&amp;category=Markets"'), "newer link goes back to page 1");
    assert.ok(html.includes('href="/?q=harbor+report&amp;category=Markets&amp;page=3"'), "older link");
    assert.ok(html.includes('data-next-page="3"'));
    assert.ok(html.includes('data-has-more="true"'));
  });
});

describe("parseFeedQuery and buildFeedHref", () => {
  it("returns defaults for an empty query", () => {
    assert.deepStrictEqual(parseFeedQuery({}), { page: 1, q: "", category: "", viewed: "all", sort: "date" });
  });

  it("trims text and treats empty or blank values as no filter", () => {
    assert.deepStrictEqual(parseFeedQuery({ q: "  harbor  ", category: " Markets " }), { page: 1, q: "harbor", category: "Markets", viewed: "all", sort: "date" });
    assert.deepStrictEqual(parseFeedQuery({ q: "", category: "   " }), { page: 1, q: "", category: "", viewed: "all", sort: "date" });
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
    assert.deepStrictEqual(parseFeedQuery({ "unknown[a]": "1", "query[x]": "1", "qq[a]": "1", q: "a" }), { page: 1, q: "a", category: "", viewed: "all", sort: "date" });
  });

  it("accepts the three viewed values, and an empty value means all", () => {
    for (const viewed of ["all", "viewed", "unviewed"]) {
      assert.strictEqual(parseFeedQuery({ viewed }).viewed, viewed);
    }
    assert.strictEqual(parseFeedQuery({ viewed: "" }).viewed, "all");
    assert.strictEqual(parseFeedQuery({ viewed: "  " }).viewed, "all");
    assert.strictEqual(parseFeedQuery({}).viewed, "all");
  });

  it("rejects every other viewed value, repeated or structured forms", () => {
    for (const viewed of ["everything", "not-viewed", "VIEWED", "1", "true", ["viewed"], ["viewed", "all"], { $ne: "x" }]) {
      assert.match(parseFeedQuery({ viewed }).error, /^viewed must/, JSON.stringify(viewed));
    }
    assert.match(parseFeedQuery({ "viewed[$ne]": "x" }).error, /^viewed must be a single value/);
    assert.match(parseFeedQuery({ "viewed[]": "viewed" }).error, /^viewed must/);
  });

  it("returns only the known fields", () => {
    const result = parseFeedQuery({ q: "a", category: "b", page: "2", $where: "1", status: "draft" });
    assert.deepStrictEqual(Object.keys(result).sort(), ["category", "page", "q", "sort", "viewed"]);
  });

  it("accepts date and popular, and an empty value means date", () => {
    for (const sort of ["date", "popular"]) {
      assert.strictEqual(parseFeedQuery({ sort }).sort, sort);
    }
    assert.strictEqual(parseFeedQuery({ sort: "" }).sort, "date");
    assert.strictEqual(parseFeedQuery({ sort: "  " }).sort, "date");
    assert.strictEqual(parseFeedQuery({}).sort, "date");
    assert.strictEqual(parseFeedQuery({ sort: " popular " }).sort, "popular");
  });

  it("rejects every other sort value, repeated or structured forms", () => {
    for (const sort of ["views", "newest", "POPULAR", "-date", "date,popular", "constructor", "__proto__", "1", ["popular"], ["date", "popular"], { $ne: "x" }]) {
      assert.match(parseFeedQuery({ sort }).error, /^sort must/, JSON.stringify(sort));
    }
    assert.match(parseFeedQuery({ "sort[$ne]": "x" }).error, /^sort must be a single value/);
    assert.match(parseFeedQuery({ "sort[]": "popular" }).error, /^sort must/);
    assert.match(parseFeedQuery({ sort: "a\nb" }).error, /^sort contains invalid characters/);
  });

  it("sort links keep popular and leave the default date out", () => {
    assert.strictEqual(buildFeedHref({ q: "", category: "", viewed: "all", sort: "date" }, 1), "/");
    assert.strictEqual(buildFeedHref({ q: "", category: "", viewed: "all", sort: "popular" }, 1), "/?sort=popular");
    assert.strictEqual(buildFeedHref({ q: "a", category: "B", viewed: "viewed", sort: "popular" }, 3), "/?q=a&category=B&viewed=viewed&sort=popular&page=3");
  });

  it("builds links that keep filters and drop empty ones", () => {
    assert.strictEqual(buildFeedHref({ q: "", category: "" }, 1), "/");
    assert.strictEqual(buildFeedHref({ q: "", category: "" }, 3), "/?page=3");
    assert.strictEqual(buildFeedHref({ q: "a&b=c", category: "Sci Fi" }, 2), "/?q=a%26b%3Dc&category=Sci+Fi&page=2");
  });

  it("links keep a viewed filter and leave viewed=all out", () => {
    assert.strictEqual(buildFeedHref({ q: "", category: "", viewed: "all" }, 1), "/");
    assert.strictEqual(buildFeedHref({ q: "a", category: "", viewed: "viewed" }, 2), "/?q=a&viewed=viewed&page=2");
    assert.strictEqual(buildFeedHref({ q: "", category: "B", viewed: "unviewed" }, 1), "/?category=B&viewed=unviewed");
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

  it("a wrong read-history model stops the seed before the article collection is touched", async () => {
    const articles = createFakeModel({ dbName: DEV_DATABASE_NAME, readyState: 1, collectionName: DEV_COLLECTION_NAME });
    const wrongReads = createFakeModel({ dbName: DEV_DATABASE_NAME, readyState: 1, collectionName: "article_reads_production" });
    await assert.rejects(() => seedDevArticles(articles.model, wrongReads.model), /article_reads_production/);
    assert.deepStrictEqual(articles.calls, []);
    assert.deepStrictEqual(wrongReads.calls, []);

    const otherDatabase = createFakeModel({ dbName: "production_news", readyState: 1, collectionName: DEV_READ_COLLECTION_NAME });
    await assert.rejects(() => seedDevArticles(articles.model, otherDatabase.model), /production_news/);
    assert.deepStrictEqual(articles.calls, []);
    assert.deepStrictEqual(otherDatabase.calls, []);
  });

  it("a wrong comments model stops the seed before anything is deleted", async () => {
    const articles = createFakeModel({ dbName: DEV_DATABASE_NAME, readyState: 1, collectionName: DEV_COLLECTION_NAME });
    const reads = createFakeModel({ dbName: DEV_DATABASE_NAME, readyState: 1, collectionName: DEV_READ_COLLECTION_NAME });
    const wrongCollection = createFakeModel({ dbName: DEV_DATABASE_NAME, readyState: 1, collectionName: "comments_production" });
    await assert.rejects(() => seedDevArticles(articles.model, reads.model, wrongCollection.model), /comments_production/);

    const otherDatabase = createFakeModel({ dbName: "production_news", readyState: 1, collectionName: DEV_COMMENTS_COLLECTION_NAME });
    await assert.rejects(() => seedDevArticles(articles.model, reads.model, otherDatabase.model), /production_news/);

    for (const fake of [articles, reads, wrongCollection, otherDatabase]) {
      assert.deepStrictEqual(fake.calls, []);
    }
  });

  it("accepts the dev database and the dev collection", () => {
    const { model } = createFakeModel({ dbName: DEV_DATABASE_NAME, readyState: 1, collectionName: DEV_COLLECTION_NAME });
    assert.doesNotThrow(() => assertModelTargetsDevCollection(model));
  });

  it("the real dev model is rejected while it has no open connection", async () => {
    // Without calling connectDevDb() the real model is not connected, so seeding must refuse.
    await assert.rejects(() => seedDevArticles(), /not on an open database connection/);
  });
});

describe("measurement guard", () => {
  const fakeModel = (dbName, readyState, collectionName) => ({ db: { name: dbName, readyState }, collection: { name: collectionName } });

  it("accepts only the bench collection of the dev database on an open connection", () => {
    assert.doesNotThrow(() => assertBenchTarget(fakeModel(DEV_DATABASE_NAME, 1, BENCH_COLLECTION_NAME)));
  });

  const rejected = [
    { label: "a different database", model: fakeModel("production_news", 1, BENCH_COLLECTION_NAME), message: /production_news/ },
    { label: "a connection that is not open", model: fakeModel(DEV_DATABASE_NAME, 0, BENCH_COLLECTION_NAME), message: /not on an open/ },
    { label: "the regular article collection", model: fakeModel(DEV_DATABASE_NAME, 1, DEV_COLLECTION_NAME), message: /dev_public_articles/ },
    { label: "the read-history collection", model: fakeModel(DEV_DATABASE_NAME, 1, DEV_READ_COLLECTION_NAME), message: /article_reads/ },
    { label: "the comments collection", model: fakeModel(DEV_DATABASE_NAME, 1, DEV_COMMENTS_COLLECTION_NAME), message: /comments/ },
    { label: "a model without a collection", model: { db: { name: DEV_DATABASE_NAME, readyState: 1 } }, message: /expected/ },
  ];

  for (const { label, model, message } of rejected) {
    it(`rejects ${label}`, () => {
      assert.throws(() => assertBenchTarget(model), message);
    });
  }

  it("the bench model uses its own collection and is not connected until the script connects", () => {
    assert.strictEqual(BenchArticle.collection.name, BENCH_COLLECTION_NAME);
    assert.notStrictEqual(BENCH_COLLECTION_NAME, DEV_COLLECTION_NAME);
    assert.throws(() => assertBenchTarget(BenchArticle), /not on an open database connection/);
  });
});

describe("device identity", () => {
  const validId = "0123456789abcdef0123456789abcdef";

  // Runs the middleware with a fake request and response and records res.cookie calls.
  function runMiddleware({ cookie, secure = false } = {}) {
    const req = { headers: cookie === undefined ? {} : { cookie }, secure };
    const cookieCalls = [];
    const res = { cookie: (name, value, options) => cookieCalls.push({ name, value, options }) };
    let nextCalls = 0;
    deviceIdentity(req, res, () => {
      nextCalls += 1;
    });
    return { req, cookieCalls, nextCalls };
  }

  it("issues a new random id with the documented cookie options", () => {
    const { req, cookieCalls, nextCalls } = runMiddleware();
    assert.strictEqual(nextCalls, 1);
    assert.match(req.deviceId, /^[0-9a-f]{32}$/);
    assert.strictEqual(cookieCalls.length, 1);
    assert.strictEqual(cookieCalls[0].name, DEVICE_COOKIE_NAME);
    assert.strictEqual(cookieCalls[0].value, req.deviceId);
    assert.deepStrictEqual(cookieCalls[0].options, {
      maxAge: DEVICE_COOKIE_MAX_AGE_MS,
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: false,
    });
    assert.strictEqual(DEVICE_COOKIE_MAX_AGE_MS, 365 * 24 * 60 * 60 * 1000);
  });

  it("two new visitors get different ids", () => {
    assert.notStrictEqual(runMiddleware().req.deviceId, runMiddleware().req.deviceId);
  });

  it("marks the cookie Secure only on an HTTPS request", () => {
    assert.strictEqual(runMiddleware({ secure: true }).cookieCalls[0].options.secure, true);
    assert.strictEqual(runMiddleware({ secure: false }).cookieCalls[0].options.secure, false);
  });

  it("reuses a valid cookie without issuing another one", () => {
    for (const cookie of [`${DEVICE_COOKIE_NAME}=${validId}`, `theme=dark; ${DEVICE_COOKIE_NAME}=${validId}; other=1`, `  ${DEVICE_COOKIE_NAME} = ${validId} `]) {
      const { req, cookieCalls, nextCalls } = runMiddleware({ cookie });
      assert.strictEqual(req.deviceId, validId, cookie);
      assert.strictEqual(cookieCalls.length, 0, cookie);
      assert.strictEqual(nextCalls, 1);
    }
  });

  it("replaces missing, malformed or wrongly encoded cookies and does not throw", () => {
    const bad = [
      "",
      "garbage",
      "=",
      ";;;",
      `${DEVICE_COOKIE_NAME}=`,
      `${DEVICE_COOKIE_NAME}=%E0%A4%A`,
      `${DEVICE_COOKIE_NAME}=%`,
      `${DEVICE_COOKIE_NAME}=${validId.toUpperCase()}`,
      `${DEVICE_COOKIE_NAME}=${validId}0`,
      `${DEVICE_COOKIE_NAME}=${validId.slice(1)}`,
      `${DEVICE_COOKIE_NAME}=${"z".repeat(32)}`,
      `${DEVICE_COOKIE_NAME}=${validId}%00`,
      `${DEVICE_COOKIE_NAME}="${validId}"`,
      `${DEVICE_COOKIE_NAME}=${"a".repeat(100000)}`,
      `x${DEVICE_COOKIE_NAME}=${validId}`,
    ];
    for (const cookie of bad) {
      const { req, cookieCalls, nextCalls } = runMiddleware({ cookie });
      assert.match(req.deviceId, /^[0-9a-f]{32}$/, cookie.slice(0, 40));
      assert.notStrictEqual(req.deviceId, validId);
      assert.strictEqual(cookieCalls.length, 1, cookie.slice(0, 40));
      assert.strictEqual(nextCalls, 1);
    }
    assert.strictEqual(readDeviceIdCookie(undefined), null);
    assert.strictEqual(readDeviceIdCookie(42), null);
  });

  it("an HTTP visit receives the cookie with the documented attributes", async () => {
    const server = createDevApp().listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    try {
      const url = `http://127.0.0.1:${server.address().port}/articles/not-an-id`;

      const first = await fetch(url);
      assert.strictEqual(first.status, 404);
      const setCookie = first.headers.getSetCookie();
      assert.strictEqual(setCookie.length, 1);
      assert.match(setCookie[0], new RegExp(`^${DEVICE_COOKIE_NAME}=[0-9a-f]{32}; `));
      assert.ok(setCookie[0].includes("Path=/"));
      assert.ok(setCookie[0].includes("HttpOnly"));
      assert.ok(setCookie[0].includes("SameSite=Lax"));
      assert.ok(setCookie[0].includes(`Max-Age=${DEVICE_COOKIE_MAX_AGE_MS / 1000}`));
      assert.ok(!setCookie[0].includes("Secure"), "plain HTTP development must still receive the cookie");

      // A returning browser sends the cookie back and gets no new one.
      const returning = await fetch(url, { headers: { cookie: setCookie[0].split(";")[0] } });
      assert.strictEqual(returning.headers.getSetCookie().length, 0);

      // The identity is never taken from the query string or other headers.
      const queryId = "f".repeat(32);
      const attempt = await fetch(`${url}?deviceId=${queryId}&dw_device=${queryId}`, { headers: { "x-device-id": queryId } });
      assert.ok(!attempt.headers.getSetCookie()[0].includes(queryId));

      // A malformed cookie value does not break the request.
      const malformed = await fetch(url, { headers: { cookie: `${DEVICE_COOKIE_NAME}=%E0%A4%A` } });
      assert.strictEqual(malformed.status, 404);
      assert.strictEqual(malformed.headers.getSetCookie().length, 1);

      // Static files do not get a device cookie.
      const css = await fetch(`http://127.0.0.1:${server.address().port}/css/public.css`);
      assert.strictEqual(css.headers.getSetCookie().length, 0);
    } finally {
      server.close();
    }
  });
});
