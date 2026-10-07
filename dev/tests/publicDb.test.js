// DEVELOPMENT ONLY. Integration checks against a real MongoDB through the dev database.
// Needs DEV_MONGODB_URI in .env or in the environment. Without it every check is SKIPPED,
// which is not a pass.
// WARNING: this file reseeds the dev collection "dev_public_articles" (see seed-public.js).
// Run with: node --test dev/tests/publicDb.test.js

require("dotenv").config({ quiet: true });

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const mongoose = require("mongoose");
const { useArticleModel, FEED_PAGE_SIZE } = require("../../services/publicArticleService");
const DevArticle = require("../devArticleModel");
const { connectDevDb } = require("../connectDevDb");
const createDevApp = require("../createDevApp");
const {
  seedDevArticles,
  PENDING_MARKER,
  DRAFT_MARKER,
  SSR_END_MARKER,
  PENDING_ONLY_WORD,
  PENDING_ONLY_CATEGORY,
  DRAFT_ONLY_WORD,
  DRAFT_ONLY_CATEGORY,
} = require("../seed-public");

const skip = process.env.DEV_MONGODB_URI ? false : "DEV_MONGODB_URI is not set: MongoDB integration checks were NOT run";

// Expected sizes come from buildSearchFixtureArticles() in seed-public.js.
const HARBOR_COUNT = 28;
const MARKETS_COUNT = 27;
const HARBOR_IN_MARKETS_COUNT = 25;
const EXPECTED_CATEGORIES = ["Business", "Culture", "Markets", "Science", "Sports", "Technology"];

function countCards(html) {
  return (html.match(/class="pub-card"/g) || []).length;
}

function cardIds(html) {
  return [...html.matchAll(/<article class="pub-card" data-article-id="([0-9a-f]{24})"/g)].map((match) => match[1]);
}

function categoryOptions(html) {
  const values = [...html.matchAll(/<option value="([^"]*)"/g)].map((match) => match[1]);
  return values.filter((value) => value !== "");
}

function feedQuery({ q, category, page } = {}) {
  const params = new URLSearchParams();
  if (q !== undefined) {
    params.set("q", q);
  }
  if (category !== undefined) {
    params.set("category", category);
  }
  if (page !== undefined) {
    params.set("page", String(page));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

// Items must be unique and sorted by date, then by id, both descending.
function assertStableOrder(items, { requireTies = false } = {}) {
  assert.strictEqual(new Set(items.map((item) => item.id)).size, items.length, "duplicate ids");

  let equalDatePairs = 0;
  for (let index = 1; index < items.length; index += 1) {
    const previous = items[index - 1];
    const current = items[index];
    assert.ok(previous.publishedAt >= current.publishedAt, "dates are not descending");
    if (previous.publishedAt === current.publishedAt) {
      equalDatePairs += 1;
      // Same date: the query sorts _id descending. Equal-length hex ids compare like ObjectIds.
      assert.ok(previous.id > current.id, `ids ${previous.id} and ${current.id} are not in descending order`);
    }
  }
  if (requireTies) {
    assert.ok(equalDatePairs > 0, "the seed data contains no equal publication dates in this result");
  }
}

describe("public feed and article page against dev MongoDB", { skip }, () => {
  let server;
  let baseUrl;
  let seeded;

  before(async () => {
    await connectDevDb();
    await DevArticle.init();
    useArticleModel(DevArticle);
    seeded = await seedDevArticles();
    server = createDevApp().listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) {
      server.close();
    }
    await mongoose.disconnect();
  });

  async function getJson(pathAndQuery) {
    const response = await fetch(baseUrl + pathAndQuery);
    return { status: response.status, body: await response.json() };
  }

  async function getHtml(pathAndQuery) {
    const response = await fetch(baseUrl + pathAndQuery);
    return { status: response.status, html: await response.text() };
  }

  // Reads feed pages until hasMore is false. Returns every page body in order.
  async function fetchAllPages(filters = {}) {
    const pages = [];
    for (let page = 1; page <= 10; page += 1) {
      const { status, body } = await getJson(`/api/public/articles${feedQuery({ ...filters, page })}`);
      assert.strictEqual(status, 200);
      pages.push(body);
      if (!body.hasMore) {
        return pages;
      }
    }
    throw new Error("the feed did not end within 10 pages");
  }

  async function fetchAllItems(filters = {}) {
    const pages = await fetchAllPages(filters);
    return pages.flatMap((body) => body.items);
  }

  describe("feed without filters", () => {
    it("page 1 returns 20 approved items with only public fields", async () => {
      const { status, body } = await getJson("/api/public/articles");
      assert.strictEqual(status, 200);
      assert.strictEqual(body.items.length, FEED_PAGE_SIZE);
      assert.strictEqual(body.page, 1);
      assert.strictEqual(body.hasMore, true);
      for (const item of body.items) {
        assert.deepStrictEqual(Object.keys(item).sort(), ["authorName", "category", "id", "imageUrl", "publishedAt", "summary", "title"]);
      }
    });

    it("all pages together contain every approved article, 20 per page, and then stop", async () => {
      const pages = await fetchAllPages();
      assert.strictEqual(pages.flatMap((body) => body.items).length, seeded.approvedCount);
      pages.slice(0, -1).forEach((body) => assert.strictEqual(body.items.length, FEED_PAGE_SIZE));
      assert.strictEqual(pages[pages.length - 1].hasMore, false);

      const beyond = await getJson(`/api/public/articles?page=${pages.length + 1}`);
      assert.deepStrictEqual(beyond.body.items, []);
      assert.strictEqual(beyond.body.hasMore, false);
    });

    it("pages have no duplicates and are ordered by date, then by id, newest first", async () => {
      assertStableOrder(await fetchAllItems(), { requireTies: true });
    });

    it("empty filter values behave like no filter", async () => {
      const unfiltered = (await getJson("/api/public/articles")).body;
      for (const query of ["?q=&category=", "?q=%20%20&category=%20", "?q="]) {
        const { status, body } = await getJson(`/api/public/articles${query}`);
        assert.strictEqual(status, 200, query);
        assert.deepStrictEqual(body.items.map((item) => item.id), unfiltered.items.map((item) => item.id), query);
        assert.strictEqual(body.hasMore, unfiltered.hasMore);
      }
    });

    it("structured and repeated forms of q, category and page are rejected on both routes", async () => {
      const rejected = ["q[$ne]=x", "q[]=a", "category[$gt]=", "page[a]=1", "q=a&q=b", "category=a&category=b", "page=1&page=2"];
      for (const query of rejected) {
        assert.strictEqual((await getJson(`/api/public/articles?${query}`)).status, 400, `API ${query}`);
        assert.strictEqual((await getHtml(`/?${query}`)).status, 400, `HTML ${query}`);
      }
    });

    it("unrelated unknown parameters are ignored", async () => {
      const unfiltered = (await getJson("/api/public/articles")).body;
      for (const query of ["?unknown=1&status=draft&$where=1", "?unknown[a]=1"]) {
        const { status, body } = await getJson(`/api/public/articles${query}`);
        assert.strictEqual(status, 200, query);
        assert.deepStrictEqual(body.items.map((item) => item.id), unfiltered.items.map((item) => item.id), query);
        assert.strictEqual((await getHtml(`/${query}`)).status, 200, query);
      }
    });

    it("a pending update never replaces or leaks into the approved version (JSON)", async () => {
      const items = await fetchAllItems();
      const item = items.find((entry) => entry.id === seeded.pendingUpdateId);
      assert.ok(item, "the article with a pending update stays public");
      assert.strictEqual(item.title, "Approved version: city opens new library");
      assert.strictEqual(item.category, "Culture");
      const text = JSON.stringify(items);
      assert.ok(!text.includes(PENDING_MARKER));
      assert.ok(!text.includes(DRAFT_MARKER));
      assert.ok(!text.includes("pending.jpg"));
    });
  });

  describe("title text index", () => {
    it("covers only the approved title", async () => {
      const indexes = await DevArticle.collection.indexes();
      const textIndexes = indexes.filter((index) => index.weights);
      assert.strictEqual(textIndexes.length, 1);
      assert.deepStrictEqual(textIndexes[0].weights, { "approved.title": 1 });
      assert.strictEqual(textIndexes[0].default_language, "english");
    });
  });

  describe("search and category filters", () => {
    it("q alone: filters before pagination, so page 1 is full and page 2 has the rest", async () => {
      const pages = await fetchAllPages({ q: "harbor" });
      assert.strictEqual(pages.length, 2);
      assert.strictEqual(pages[0].items.length, FEED_PAGE_SIZE);
      assert.strictEqual(pages[0].hasMore, true);
      assert.strictEqual(pages[1].items.length, HARBOR_COUNT - FEED_PAGE_SIZE);
      assert.strictEqual(pages[1].hasMore, false);
      for (const item of pages.flatMap((body) => body.items)) {
        assert.match(item.title, /harbor/i);
      }
    });

    it("category alone", async () => {
      const pages = await fetchAllPages({ category: "Markets" });
      assert.strictEqual(pages.length, 2);
      assert.strictEqual(pages[0].items.length, FEED_PAGE_SIZE);
      assert.strictEqual(pages[1].items.length, MARKETS_COUNT - FEED_PAGE_SIZE);
      assert.strictEqual(pages[1].hasMore, false);
      for (const item of pages.flatMap((body) => body.items)) {
        assert.strictEqual(item.category, "Markets");
      }
    });

    it("q and category together, across two pages", async () => {
      const pages = await fetchAllPages({ q: "harbor", category: "Markets" });
      assert.strictEqual(pages.length, 2);
      assert.strictEqual(pages[0].items.length, FEED_PAGE_SIZE);
      assert.strictEqual(pages[0].hasMore, true);
      assert.strictEqual(pages[1].items.length, HARBOR_IN_MARKETS_COUNT - FEED_PAGE_SIZE);
      assert.strictEqual(pages[1].hasMore, false);
      for (const item of pages.flatMap((body) => body.items)) {
        assert.strictEqual(item.category, "Markets");
        assert.match(item.title, /harbor/i);
      }
    });

    it("filtered pages keep a stable order with no duplicates", async () => {
      assertStableOrder(await fetchAllItems({ q: "harbor" }), { requireTies: true });
      assertStableOrder(await fetchAllItems({ category: "Markets" }), { requireTies: true });
      assertStableOrder(await fetchAllItems({ q: "harbor", category: "Markets" }), { requireTies: true });
    });

    it("a valid category with no matching articles gives an empty result", async () => {
      for (const query of [{ category: "NoSuchCategory" }, { q: "harbor", category: "Technology" }, { q: "nomatchwordxyz" }]) {
        const { status, body } = await getJson(`/api/public/articles${feedQuery(query)}`);
        assert.strictEqual(status, 200);
        assert.deepStrictEqual(body, { items: [], page: 1, hasMore: false });
      }
    });

    it("search ignores case and uses English stemming, but it is not a substring search", async () => {
      assert.strictEqual((await fetchAllItems({ q: "HARBOR" })).length, HARBOR_COUNT);

      const stemmed = await fetchAllItems({ q: "libraries" });
      assert.deepStrictEqual(stemmed.map((item) => item.id), [seeded.pendingUpdateId], "libraries finds library");

      for (const partialWord of ["libr", "harb"]) {
        assert.deepStrictEqual(await fetchAllItems({ q: partialWord }), [], `${partialWord} is only part of a word`);
      }
    });

    it("several words match any of them; quotes and a minus sign work as documented", async () => {
      const either = await fetchAllItems({ q: "festival stocks" });
      assert.deepStrictEqual(either.map((item) => item.title).sort(), ["Harbor festival opens this weekend", "Stocks close higher"]);

      assert.strictEqual((await fetchAllItems({ q: '"harbor report"' })).length, HARBOR_IN_MARKETS_COUNT);
      const withoutFestival = await fetchAllItems({ q: "harbor -festival" });
      assert.strictEqual(withoutFestival.length, HARBOR_COUNT - 1);
    });

    it("a query made only of stop words finds nothing", async () => {
      assert.deepStrictEqual(await fetchAllItems({ q: "the" }), []);
    });

    it("search covers the title only, not the summary or the content", async () => {
      // "paragraph" appears only in contents, "summary" only in summaries.
      for (const word of ["paragraph", "summary", "fixture"]) {
        assert.deepStrictEqual(await fetchAllItems({ q: word }), [], word);
      }
    });
  });

  describe("pending and draft values stay hidden", () => {
    it("pending and draft only words and categories find nothing", async () => {
      const queries = [
        { q: PENDING_ONLY_WORD },
        { q: DRAFT_ONLY_WORD },
        { category: PENDING_ONLY_CATEGORY },
        { category: DRAFT_ONLY_CATEGORY },
        { q: PENDING_ONLY_WORD, category: "Culture" },
      ];
      for (const query of queries) {
        const { status, body } = await getJson(`/api/public/articles${feedQuery(query)}`);
        assert.strictEqual(status, 200);
        assert.deepStrictEqual(body.items, [], JSON.stringify(query));
      }
    });

    it("the stored category options never include pending or draft categories", async () => {
      for (const query of ["", feedQuery({ q: PENDING_ONLY_WORD })]) {
        const { status, html } = await getHtml(`/${query}`);
        assert.strictEqual(status, 200);
        assert.deepStrictEqual(categoryOptions(html), EXPECTED_CATEGORIES, query);
        assert.ok(!html.includes(PENDING_MARKER));
        assert.ok(!html.includes(DRAFT_MARKER));
        assert.ok(!html.includes("pending.jpg"));
      }
    });

    it("a category typed in the URL is echoed as the selected option and nothing else is added", async () => {
      // The echoed option is the user's own input. Only that one extra option may appear.
      for (const category of [PENDING_ONLY_CATEGORY, DRAFT_ONLY_CATEGORY, "NoSuchCategory"]) {
        const { status, html } = await getHtml(`/${feedQuery({ category })}`);
        assert.strictEqual(status, 200);
        assert.deepStrictEqual(categoryOptions(html), [...EXPECTED_CATEGORIES, category], category);
        assert.ok(html.includes(`<option value="${category}" selected>${category}</option>`));
        assert.strictEqual(cardIds(html).length, 0);
        assert.ok(!html.includes(PENDING_MARKER));
        assert.ok(!html.includes(DRAFT_MARKER));
      }
    });

    it("a listed category is selected without a duplicate option", async () => {
      const { html } = await getHtml(`/${feedQuery({ category: "Markets" })}`);
      assert.deepStrictEqual(categoryOptions(html), EXPECTED_CATEGORIES);
      assert.ok(html.includes('<option value="Markets" selected>Markets</option>'));
    });
  });

  describe("server-rendered page and JSON feed agree", () => {
    const filterCases = [
      { label: "no filters", filters: {} },
      { label: "search", filters: { q: "harbor" } },
      { label: "category", filters: { category: "Markets" } },
      { label: "search and category", filters: { q: "harbor", category: "Markets" } },
      { label: "no results", filters: { q: "nomatchwordxyz" } },
    ];

    for (const { label, filters } of filterCases) {
      it(`same articles on page 1 and page 2 for ${label}`, async () => {
        for (const page of [1, 2]) {
          const json = (await getJson(`/api/public/articles${feedQuery({ ...filters, page })}`)).body;
          const { status, html } = await getHtml(`/${feedQuery({ ...filters, page })}`);
          assert.strictEqual(status, 200);
          assert.deepStrictEqual(cardIds(html), json.items.map((item) => item.id), `${label} page ${page}`);
          assert.strictEqual(html.includes('data-has-more="true"'), json.hasMore);
        }
      });
    }

    it("the form shows the active filters and the pager keeps them", async () => {
      const { html } = await getHtml(`/${feedQuery({ q: "harbor", category: "Markets" })}`);
      assert.ok(html.includes('value="harbor"'));
      assert.ok(html.includes('<option value="Markets" selected>Markets</option>'));
      assert.ok(html.includes('href="/?q=harbor&amp;category=Markets&amp;page=2"'));
      assert.deepStrictEqual(categoryOptions(html), EXPECTED_CATEGORIES, "the category list is not narrowed by the filters");
    });

    it("an empty result shows the no-match message", async () => {
      const { status, html } = await getHtml(`/${feedQuery({ q: "nomatchwordxyz" })}`);
      assert.strictEqual(status, 200);
      assert.strictEqual(countCards(html), 0);
      assert.ok(html.includes("No articles match your search or category."));
    });
  });

  describe("home page and article page", () => {
    it("home page renders 20 cards on page 1 and no hidden text", async () => {
      const page1 = await (await fetch(`${baseUrl}/`)).text();
      assert.strictEqual(countCards(page1), FEED_PAGE_SIZE);
      assert.ok(page1.includes("Approved version: city opens new library"));
      assert.ok(page1.includes('href="/?page=2"'));
      assert.ok(!page1.includes(PENDING_MARKER));
      assert.ok(!page1.includes(DRAFT_MARKER));

      const page2 = await (await fetch(`${baseUrl}/?page=2`)).text();
      assert.strictEqual(countCards(page2), Math.min(FEED_PAGE_SIZE, seeded.approvedCount - FEED_PAGE_SIZE));
    });

    it("article page contains the full approved content in the initial HTML", async () => {
      const response = await fetch(`${baseUrl}/articles/${seeded.pendingUpdateId}`);
      assert.strictEqual(response.status, 200);
      const html = await response.text();
      assert.ok(html.includes("Approved paragraph one."));
      assert.ok(html.includes(SSR_END_MARKER));
      assert.ok(!html.includes(PENDING_MARKER));
      assert.ok(!html.includes("pending.jpg"));
    });

    it("a draft-only article is not reachable by id", async () => {
      const response = await fetch(`${baseUrl}/articles/${seeded.draftOnlyId}`);
      assert.strictEqual(response.status, 404);
      assert.ok(!(await response.text()).includes(DRAFT_MARKER));
    });

    it("a well-formed id that does not exist gives 404", async () => {
      const response = await fetch(`${baseUrl}/articles/${new mongoose.Types.ObjectId()}`);
      assert.strictEqual(response.status, 404);
    });

    it("user markup is escaped on both pages", async () => {
      const article = await (await fetch(`${baseUrl}/articles/${seeded.scriptInContentId}`)).text();
      assert.ok(article.includes("&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;"));
      assert.ok(!article.includes("<script>alert"));
      assert.ok(article.includes("Escaping check &lt;b&gt;bold title&lt;/b&gt;"));
    });

    it("an unsafe image URL is not rendered", async () => {
      const article = await (await fetch(`${baseUrl}/articles/${seeded.unsafeImageId}`)).text();
      assert.ok(!article.includes("javascript:"));
      const home = await (await fetch(`${baseUrl}/`)).text();
      assert.ok(!home.includes("javascript:"));
    });
  });
});
