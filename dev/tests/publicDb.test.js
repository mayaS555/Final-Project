// DEVELOPMENT ONLY. Integration checks against a real MongoDB through the dev database.
// Needs DEV_MONGODB_URI in .env or in the environment. Without it every check is SKIPPED,
// which is not a pass.
// WARNING: this file reseeds the dev collection "dev_public_articles" (see seed-public.js).
// Run with: node --test dev/tests/publicDb.test.js

require("dotenv").config({ quiet: true });

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const mongoose = require("mongoose");
const ArticleRead = require("../../models/ArticleRead");
const Comment = require("../../models/Comment");
const { markArticleRead } = require("../../services/articleReadService");
const { useArticleModel, FEED_PAGE_SIZE } = require("../../services/publicArticleService");
const DevArticle = require("../devArticleModel");
const { connectDevDb } = require("../connectDevDb");
const createDevApp = require("../createDevApp");
const {
  seedDevArticles,
  clearDevArticleReads,
  clearDevComments,
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
  const select = html.match(/<select name="category"[\s\S]*?<\/select>/)[0];
  const values = [...select.matchAll(/<option value="([^"]*)"/g)].map((match) => match[1]);
  return values.filter((value) => value !== "");
}

function feedQuery({ q, category, viewed, page } = {}) {
  const params = new URLSearchParams();
  if (q !== undefined) {
    params.set("q", q);
  }
  if (category !== undefined) {
    params.set("category", category);
  }
  if (viewed !== undefined) {
    params.set("viewed", viewed);
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
    await ArticleRead.init();
    await Comment.init();
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
    // Guarded: only the dev read-history collection is cleared.
    await clearDevArticleReads();
    await clearDevComments();
    await mongoose.disconnect();
  });

  // Node fetch has no cookie jar. A test acts as a device by sending the cookie itself.
  function cookieHeader(deviceId) {
    return deviceId ? { cookie: `dw_device=${deviceId}` } : {};
  }

  function newDeviceId() {
    return crypto.randomBytes(16).toString("hex");
  }

  async function getJson(pathAndQuery, deviceId) {
    const response = await fetch(baseUrl + pathAndQuery, { headers: cookieHeader(deviceId) });
    return { status: response.status, body: await response.json() };
  }

  async function getHtml(pathAndQuery, deviceId) {
    const response = await fetch(baseUrl + pathAndQuery, { headers: cookieHeader(deviceId) });
    return { status: response.status, html: await response.text() };
  }

  // Reads feed pages until hasMore is false. Returns every page body in order.
  async function fetchAllPages(filters = {}, deviceId) {
    const pages = [];
    for (let page = 1; page <= 10; page += 1) {
      const { status, body } = await getJson(`/api/public/articles${feedQuery({ ...filters, page })}`, deviceId);
      assert.strictEqual(status, 200);
      pages.push(body);
      if (!body.hasMore) {
        return pages;
      }
    }
    throw new Error("the feed did not end within 10 pages");
  }

  async function fetchAllItems(filters = {}, deviceId) {
    const pages = await fetchAllPages(filters, deviceId);
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
      assert.ok(html.includes("No articles match your filters."));
    });
  });

  describe("per-device viewed state", () => {
    // Opens an article page as a device, exactly like a browser would.
    async function openArticle(deviceId, articleId) {
      const response = await fetch(`${baseUrl}/articles/${articleId}`, { headers: cookieHeader(deviceId) });
      await response.text();
      return response;
    }

    async function readRecords(deviceId) {
      return ArticleRead.find({ deviceId }).lean();
    }

    // Replaces a model method for one test and always restores it.
    // find() returns a query-like object because the service chains .select().lean() on it.
    async function withBrokenMethod(method, run) {
      const originalConsoleError = console.error;
      const logged = [];
      console.error = (...args) => logged.push(args);
      const fail = async () => {
        throw new Error(`simulated ${method} failure`);
      };
      ArticleRead[method] = method === "find" ? () => ({ select: () => ({ lean: fail }) }) : fail;
      try {
        await run(logged);
      } finally {
        delete ArticleRead[method];
        console.error = originalConsoleError;
      }
    }

    let harborMarketsIds;

    before(async () => {
      // 25 articles, newest first. Marking 22 of them makes a viewed result larger than one page.
      harborMarketsIds = (await fetchAllItems({ q: "harbor", category: "Markets" })).map((item) => item.id);
    });

    it("the read collection has the unique (deviceId, articleId) index", async () => {
      const indexes = await ArticleRead.collection.indexes();
      const unique = indexes.find((index) => index.unique && JSON.stringify(index.key) === JSON.stringify({ deviceId: 1, articleId: 1 }));
      assert.ok(unique, "unique compound index is missing");
    });

    it("a new visitor gets a device cookie and the opened article is stored for that device", async () => {
      const response = await fetch(`${baseUrl}/articles/${seeded.pendingUpdateId}`);
      assert.strictEqual(response.status, 200);
      assert.ok((await response.text()).includes("Approved paragraph one."), "full content stays in the initial HTML");

      const setCookie = response.headers.getSetCookie();
      assert.strictEqual(setCookie.length, 1);
      const deviceId = setCookie[0].match(/^dw_device=([0-9a-f]{32});/)[1];

      const records = await readRecords(deviceId);
      assert.strictEqual(records.length, 1);
      assert.strictEqual(String(records[0].articleId), seeded.pendingUpdateId);
      assert.ok(records[0].readAt instanceof Date);
      assert.deepStrictEqual(Object.keys(records[0]).sort(), ["__v", "_id", "articleId", "deviceId", "readAt"]);
    });

    it("a returning device reuses its identity and keeps one record per article", async () => {
      const deviceId = newDeviceId();
      const first = await openArticle(deviceId, seeded.pendingUpdateId);
      assert.strictEqual(first.headers.getSetCookie().length, 0, "a valid cookie is reused");
      const before = (await readRecords(deviceId))[0];

      await openArticle(deviceId, seeded.pendingUpdateId);
      await openArticle(deviceId, seeded.pendingUpdateId);
      const after = await readRecords(deviceId);
      assert.strictEqual(after.length, 1);
      assert.strictEqual(String(after[0]._id), String(before._id), "the same record is updated");
      assert.ok(after[0].readAt >= before.readAt);
    });

    it("a malformed cookie does not break the page and the new identity is the one stored", async () => {
      const badValue = "%E0%A4%A";
      const response = await fetch(`${baseUrl}/articles/${seeded.pendingUpdateId}`, { headers: { cookie: `dw_device=${badValue}` } });
      assert.strictEqual(response.status, 200);
      const deviceId = response.headers.getSetCookie()[0].match(/^dw_device=([0-9a-f]{32});/)[1];
      assert.strictEqual((await readRecords(deviceId)).length, 1);
      assert.strictEqual(await ArticleRead.countDocuments({ deviceId: badValue }), 0);
    });

    it("the device id cannot be chosen through the query string or a header", async () => {
      const chosen = newDeviceId();
      const response = await fetch(`${baseUrl}/articles/${seeded.pendingUpdateId}?deviceId=${chosen}&dw_device=${chosen}`, { headers: { "x-device-id": chosen } });
      await response.text();
      assert.strictEqual(response.status, 200);
      assert.strictEqual(await ArticleRead.countDocuments({ deviceId: chosen }), 0);
    });

    it("only articles that were found in the public set are marked", async () => {
      const deviceId = newDeviceId();
      const missingId = String(new mongoose.Types.ObjectId());

      for (const id of [seeded.draftOnlyId, missingId, "not-an-id", "zzzzzzzzzzzzzzzzzzzzzzzz"]) {
        const response = await openArticle(deviceId, id);
        assert.strictEqual(response.status, 404, id);
      }
      assert.strictEqual((await readRecords(deviceId)).length, 0);

      assert.strictEqual((await openArticle(deviceId, seeded.pendingUpdateId)).status, 200);
      const records = await readRecords(deviceId);
      assert.deepStrictEqual(records.map((record) => String(record.articleId)), [seeded.pendingUpdateId]);
    });

    it("feed requests do not mark anything as viewed", async () => {
      const deviceId = newDeviceId();
      await getJson("/api/public/articles", deviceId);
      await getJson("/api/public/articles?viewed=viewed", deviceId);
      await getJson("/api/public/articles?viewed=unviewed&q=harbor", deviceId);
      await getHtml("/", deviceId);
      await getHtml("/?viewed=unviewed&page=2", deviceId);
      assert.strictEqual((await readRecords(deviceId)).length, 0);
    });

    it("repeated and simultaneous visits leave one record per device and article", async () => {
      const deviceId = newDeviceId();
      const articleIds = harborMarketsIds.slice(0, 3);

      // 30 simultaneous page visits for 3 articles, 10 each.
      const visits = [];
      for (let round = 0; round < 10; round += 1) {
        for (const id of articleIds) {
          visits.push(openArticle(deviceId, id));
        }
      }
      const responses = await Promise.all(visits);
      assert.ok(responses.every((response) => response.status === 200));
      assert.strictEqual(await ArticleRead.countDocuments({ deviceId }), 3);

      // 40 simultaneous writes straight to the service for one new key.
      const otherDevice = newDeviceId();
      const results = await Promise.allSettled(Array.from({ length: 40 }, () => markArticleRead(otherDevice, articleIds[0])));
      assert.ok(results.every((result) => result.status === "fulfilled"), JSON.stringify(results.filter((result) => result.status === "rejected").map((result) => String(result.reason))));
      assert.strictEqual(await ArticleRead.countDocuments({ deviceId: otherDevice }), 1);
    });

    it("two devices keep independent histories", async () => {
      const deviceA = newDeviceId();
      const deviceB = newDeviceId();
      const [first, second, third] = harborMarketsIds;

      await openArticle(deviceA, first);
      await openArticle(deviceA, second);
      await openArticle(deviceB, second);
      await openArticle(deviceB, third);

      const viewedA = (await fetchAllItems({ viewed: "viewed" }, deviceA)).map((item) => item.id);
      const viewedB = (await fetchAllItems({ viewed: "viewed" }, deviceB)).map((item) => item.id);
      assert.deepStrictEqual(viewedA, [first, second]);
      assert.deepStrictEqual(viewedB, [second, third]);

      const unviewedA = (await fetchAllItems({ viewed: "unviewed" }, deviceA)).map((item) => item.id);
      assert.ok(!unviewedA.includes(first) && !unviewedA.includes(second));
      assert.ok(unviewedA.includes(third), "an article opened only by the other device is unviewed here");
    });

    it("a new device has no viewed articles and every public article is unviewed", async () => {
      const deviceId = newDeviceId();
      assert.deepStrictEqual(await getJson("/api/public/articles?viewed=viewed", deviceId), {
        status: 200,
        body: { items: [], page: 1, hasMore: false },
      });
      assert.strictEqual((await fetchAllItems({ viewed: "unviewed" }, deviceId)).length, seeded.approvedCount);
      assert.strictEqual((await fetchAllItems({ viewed: "all" }, deviceId)).length, seeded.approvedCount);

      // Without any cookie the request gets a fresh identity and behaves the same way.
      const noCookie = await fetch(`${baseUrl}/api/public/articles?viewed=viewed`);
      assert.deepStrictEqual(await noCookie.json(), { items: [], page: 1, hasMore: false });
      assert.strictEqual(noCookie.headers.getSetCookie().length, 1);
    });

    it("all, viewed and unviewed give the right articles in a stable order", async () => {
      const deviceId = newDeviceId();
      const everything = (await fetchAllItems({}, deviceId)).map((item) => item.id);
      const opened = [everything[0], everything[7], everything[30]];
      for (const id of opened) {
        await openArticle(deviceId, id);
      }

      const viewed = await fetchAllItems({ viewed: "viewed" }, deviceId);
      assert.deepStrictEqual(viewed.map((item) => item.id), opened, "newest first");

      const unviewed = await fetchAllItems({ viewed: "unviewed" }, deviceId);
      assertStableOrder(unviewed);
      assert.deepStrictEqual(unviewed.map((item) => item.id), everything.filter((id) => !opened.includes(id)));

      const all = (await fetchAllItems({ viewed: "all" }, deviceId)).map((item) => item.id);
      assert.deepStrictEqual(all, everything);
      assert.deepStrictEqual((await fetchAllItems({ viewed: "" }, deviceId)).map((item) => item.id), everything);
    });

    it("viewed combines with search and category and is applied before pagination", async () => {
      const deviceId = newDeviceId();
      // 22 of the 25 harbor reports in Markets (page size is 20).
      const opened = harborMarketsIds.slice(0, 22);
      await Promise.all(opened.map((id) => openArticle(deviceId, id)));

      const viewedPages = await fetchAllPages({ q: "harbor", category: "Markets", viewed: "viewed" }, deviceId);
      assert.strictEqual(viewedPages.length, 2);
      assert.strictEqual(viewedPages[0].items.length, FEED_PAGE_SIZE);
      assert.strictEqual(viewedPages[0].hasMore, true);
      assert.strictEqual(viewedPages[1].items.length, 2);
      assert.strictEqual(viewedPages[1].hasMore, false);
      assertStableOrder(viewedPages.flatMap((body) => body.items), { requireTies: true });
      assert.deepStrictEqual(viewedPages.flatMap((body) => body.items).map((item) => item.id), opened);

      // The three unread reports fill only the first page: nothing is cut after filtering.
      const unviewedPages = await fetchAllPages({ q: "harbor", category: "Markets", viewed: "unviewed" }, deviceId);
      assert.strictEqual(unviewedPages.length, 1);
      assert.deepStrictEqual(unviewedPages[0].items.map((item) => item.id), harborMarketsIds.slice(22));
      assert.strictEqual(unviewedPages[0].hasMore, false);

      // Search alone: 28 harbor articles, 22 of them viewed.
      assert.strictEqual((await fetchAllItems({ q: "harbor", viewed: "viewed" }, deviceId)).length, 22);
      assert.strictEqual((await fetchAllItems({ q: "harbor", viewed: "unviewed" }, deviceId)).length, HARBOR_COUNT - 22);

      // Category alone: 27 Markets articles, 22 of them viewed.
      assert.strictEqual((await fetchAllItems({ category: "Markets", viewed: "viewed" }, deviceId)).length, 22);
      assert.strictEqual((await fetchAllItems({ category: "Markets", viewed: "unviewed" }, deviceId)).length, MARKETS_COUNT - 22);

      // No filter except viewed: 63 - 22 = 41 articles over three pages (20, 20, 1).
      const unviewedAll = await fetchAllPages({ viewed: "unviewed" }, deviceId);
      assert.deepStrictEqual(unviewedAll.map((body) => body.items.length), [20, 20, seeded.approvedCount - 22 - 40]);
      assert.strictEqual(unviewedAll[0].hasMore, true);
      assert.strictEqual(unviewedAll[2].hasMore, false);

      // A combination that matches nothing is an empty result, not an error.
      const none = await getJson(`/api/public/articles${feedQuery({ q: "harbor", category: "Technology", viewed: "viewed" })}`, deviceId);
      assert.deepStrictEqual(none.body, { items: [], page: 1, hasMore: false });
    });

    it("the home page and the JSON feed agree for viewed filters, and the form keeps the choice", async () => {
      const deviceId = newDeviceId();
      await Promise.all(harborMarketsIds.slice(0, 22).map((id) => openArticle(deviceId, id)));

      const cases = [{ viewed: "viewed" }, { viewed: "unviewed" }, { q: "harbor", viewed: "viewed" }, { q: "harbor", category: "Markets", viewed: "unviewed" }];
      for (const filters of cases) {
        for (const page of [1, 2]) {
          const json = (await getJson(`/api/public/articles${feedQuery({ ...filters, page })}`, deviceId)).body;
          const { status, html } = await getHtml(`/${feedQuery({ ...filters, page })}`, deviceId);
          assert.strictEqual(status, 200);
          assert.deepStrictEqual(cardIds(html), json.items.map((item) => item.id), JSON.stringify({ filters, page }));
          assert.strictEqual(html.includes('data-has-more="true"'), json.hasMore);
          assert.ok(html.includes(`<option value="${filters.viewed}" selected>`));
          assert.ok(html.includes(`data-viewed="${filters.viewed}"`));
        }
      }

      const { html } = await getHtml(`/${feedQuery({ q: "harbor", viewed: "viewed" })}`, deviceId);
      assert.ok(html.includes('href="/?q=harbor&amp;viewed=viewed&amp;page=2"'), "the pager keeps the viewed filter");
    });

    it("invalid viewed values are rejected on both routes", async () => {
      for (const query of ["viewed=bogus", "viewed=not-viewed", "viewed=viewed&viewed=all", "viewed[$ne]=x", "viewed[]=viewed"]) {
        assert.strictEqual((await getJson(`/api/public/articles?${query}`)).status, 400, `API ${query}`);
        assert.strictEqual((await getHtml(`/?${query}`)).status, 400, `HTML ${query}`);
      }
    });

    it("the feed response must not be shared between devices by a cache", async () => {
      const response = await fetch(`${baseUrl}/api/public/articles?viewed=viewed`);
      assert.strictEqual(response.headers.get("cache-control"), "private, no-cache");
      const page = await fetch(`${baseUrl}/?viewed=viewed`);
      assert.strictEqual(page.headers.get("cache-control"), "private, no-cache");
    });

    it("pending and draft content stays hidden when the viewed filter is used", async () => {
      const deviceId = newDeviceId();
      await openArticle(deviceId, seeded.pendingUpdateId);

      const viewed = await fetchAllItems({ viewed: "viewed" }, deviceId);
      assert.deepStrictEqual(viewed.map((item) => item.title), ["Approved version: city opens new library"]);
      assert.ok(!JSON.stringify(viewed).includes(PENDING_MARKER));

      for (const filters of [{ q: PENDING_ONLY_WORD }, { category: PENDING_ONLY_CATEGORY }, { q: DRAFT_ONLY_WORD }, { category: DRAFT_ONLY_CATEGORY }]) {
        for (const viewedValue of ["viewed", "unviewed"]) {
          const { body } = await getJson(`/api/public/articles${feedQuery({ ...filters, viewed: viewedValue })}`, deviceId);
          assert.deepStrictEqual(body.items, [], JSON.stringify({ filters, viewedValue }));
        }
      }
      const { html } = await getHtml("/?viewed=viewed", deviceId);
      assert.ok(!html.includes(PENDING_MARKER) && !html.includes(DRAFT_MARKER));
    });

    it("a read record for a nonpublic article never makes it appear", async () => {
      const deviceId = newDeviceId();
      // Simulates a stale record, for example for an article that was unpublished later.
      await ArticleRead.create({ deviceId, articleId: seeded.draftOnlyId, readAt: new Date() });

      assert.deepStrictEqual((await fetchAllItems({ viewed: "viewed" }, deviceId)), []);
      const unviewed = await fetchAllItems({ viewed: "unviewed" }, deviceId);
      assert.strictEqual(unviewed.length, seeded.approvedCount);
      assert.ok(!unviewed.some((item) => item.id === seeded.draftOnlyId));
    });

    it("a failing read-state write is logged and the article is still served", async () => {
      const deviceId = newDeviceId();
      await withBrokenMethod("updateOne", async (logged) => {
        const response = await fetch(`${baseUrl}/articles/${seeded.pendingUpdateId}`, { headers: cookieHeader(deviceId) });
        assert.strictEqual(response.status, 200);
        const html = await response.text();
        assert.ok(html.includes("Approved paragraph one."));
        assert.ok(html.includes(SSR_END_MARKER));
        assert.strictEqual(logged.length, 1, "the failure is logged once");
        assert.match(String(logged[0][0]), /read state/);
        assert.ok(!html.includes("simulated"), "no internal detail in the page");
      });
      assert.strictEqual((await readRecords(deviceId)).length, 0);
    });

    it("a failing history read is an error for viewed and unviewed, never an unfiltered feed", async () => {
      const deviceId = newDeviceId();
      await withBrokenMethod("find", async (logged) => {
        for (const viewed of ["viewed", "unviewed"]) {
          const api = await fetch(`${baseUrl}/api/public/articles?viewed=${viewed}`, { headers: cookieHeader(deviceId) });
          assert.strictEqual(api.status, 500, `API ${viewed}`);
          const apiText = await api.text();
          assert.ok(!apiText.includes("items"), "no feed data in the error");
          assert.ok(!apiText.includes("simulated"));

          const page = await fetch(`${baseUrl}/?viewed=${viewed}`, { headers: cookieHeader(deviceId) });
          assert.strictEqual(page.status, 500, `HTML ${viewed}`);
          assert.strictEqual(cardIds(await page.text()).length, 0);
        }
        assert.strictEqual(logged.length, 4);

        // Without a viewed filter the history is not needed, so the feed still works.
        assert.strictEqual((await getJson("/api/public/articles", deviceId)).status, 200);
        assert.strictEqual((await getHtml("/", deviceId)).status, 200);
      });
    });
  });

  describe("comments", () => {
    const HOSTILE = '<script>alert("x")</script><img src=x onerror=alert(1)>';
    let articleId;
    let otherArticleId;

    // JSON request as a device. Node fetch has no cookie jar, so the cookie is sent by hand.
    async function api(method, pathAndQuery, { deviceId, body, headers } = {}) {
      const response = await fetch(baseUrl + pathAndQuery, {
        method,
        headers: { "Content-Type": "application/json", ...cookieHeader(deviceId), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      return { status: response.status, headers: response.headers, text, body: text ? JSON.parse(text) : null };
    }

    const commentsPath = (id) => `/api/public/articles/${id}/comments`;
    const validComment = (overrides = {}) => ({ displayName: "Dana", body: "A short comment.", ...overrides });

    function postComment(deviceId, id = articleId, body = validComment()) {
      return api("POST", commentsPath(id), { deviceId, body });
    }

    // Replaces a model method for one test and always restores it. The error log is captured.
    async function withBrokenMethod(model, method, replacement, run) {
      const originalConsoleError = console.error;
      const logged = [];
      console.error = (...args) => logged.push(args);
      model[method] = replacement;
      try {
        await run(logged);
      } finally {
        delete model[method];
        console.error = originalConsoleError;
      }
    }

    const failingCreate = async () => {
      throw new Error("simulated create failure");
    };
    // find() returns a query-like object because the service chains select, sort, limit and lean.
    const failingFind = () => {
      const query = { select: () => query, sort: () => query, limit: () => query, lean: async () => { throw new Error("simulated find failure"); } };
      return query;
    };

    before(async () => {
      articleId = seeded.pendingUpdateId;
      otherArticleId = seeded.scriptInContentId;
    });

    describe("create, read, update and delete", () => {
      it("a device creates, reads, edits and deletes its own comment", async () => {
        const deviceId = newDeviceId();
        const created = await postComment(deviceId, articleId, { displayName: "  Dana  ", body: "  Hello\r\nworld  " });
        assert.strictEqual(created.status, 201);
        assert.deepStrictEqual(Object.keys(created.body).sort(), ["articleId", "body", "canDelete", "canEdit", "createdAt", "displayName", "id", "updatedAt"]);
        assert.strictEqual(created.body.displayName, "Dana");
        assert.strictEqual(created.body.body, "Hello\nworld");
        assert.strictEqual(created.body.articleId, articleId);
        assert.strictEqual(created.body.canEdit, true);
        assert.strictEqual(created.body.canDelete, true);
        assert.strictEqual(created.body.createdAt, created.body.updatedAt);

        const stored = await Comment.findById(created.body.id).select("+deviceId").lean();
        assert.strictEqual(stored.deviceId, deviceId);
        assert.strictEqual(String(stored.articleId), articleId);

        const listed = await api("GET", commentsPath(articleId), { deviceId });
        assert.strictEqual(listed.status, 200);
        assert.deepStrictEqual(listed.body.items.map((item) => item.id), [created.body.id]);

        await new Promise((resolve) => setTimeout(resolve, 5));
        const edited = await api("PATCH", `/api/public/comments/${created.body.id}`, { deviceId, body: { body: "Edited text" } });
        assert.strictEqual(edited.status, 200);
        assert.strictEqual(edited.body.body, "Edited text");
        assert.strictEqual(edited.body.displayName, "Dana");
        assert.ok(edited.body.updatedAt > edited.body.createdAt);
        assert.strictEqual(edited.body.createdAt, created.body.createdAt);

        const removed = await api("DELETE", `/api/public/comments/${created.body.id}`, { deviceId });
        assert.strictEqual(removed.status, 204);
        assert.strictEqual(removed.text, "");
        assert.deepStrictEqual((await api("GET", commentsPath(articleId), { deviceId })).body.items, []);
        assert.strictEqual(await Comment.countDocuments({ _id: created.body.id }), 0);

        assert.strictEqual((await api("DELETE", `/api/public/comments/${created.body.id}`, { deviceId })).status, 404);
        assert.strictEqual((await api("PATCH", `/api/public/comments/${created.body.id}`, { deviceId, body: { body: "again" } })).status, 404);
      });

      it("accepts text exactly at the length limits and rejects a comment over them without storing it", async () => {
        const deviceId = newDeviceId();
        const edge = await postComment(deviceId, articleId, { displayName: "n".repeat(40), body: "b".repeat(1000) });
        assert.strictEqual(edge.status, 201);

        const before = await Comment.countDocuments({ articleId });
        for (const body of [validComment({ displayName: "n".repeat(41) }), validComment({ body: "b".repeat(1001) }), validComment({ body: "   " }), validComment({ displayName: "" })]) {
          assert.strictEqual((await postComment(deviceId, articleId, body)).status, 400);
        }
        assert.strictEqual(await Comment.countDocuments({ articleId }), before);
      });

      it("a form post from another site (not JSON) cannot create a comment", async () => {
        const deviceId = newDeviceId();
        const response = await fetch(baseUrl + commentsPath(articleId), {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", ...cookieHeader(deviceId) },
          body: "displayName=Mallory&body=spam",
        });
        assert.strictEqual(response.status, 415);
        assert.strictEqual(await Comment.countDocuments({ displayName: "Mallory" }), 0);
      });

      it("application/json with a charset parameter is accepted", async () => {
        const deviceId = newDeviceId();
        const response = await fetch(baseUrl + commentsPath(articleId), {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=utf-8", ...cookieHeader(deviceId) },
          body: JSON.stringify({ displayName: "Charset", body: "hello" }),
        });
        assert.strictEqual(response.status, 201);
      });

      it("comments of one article are not listed for another", async () => {
        const deviceId = newDeviceId();
        const created = (await postComment(deviceId, articleId)).body;
        const other = await api("GET", commentsPath(otherArticleId), { deviceId });
        assert.ok(!other.body.items.some((item) => item.id === created.id));
        assert.ok((await api("GET", commentsPath(articleId), { deviceId })).body.items.some((item) => item.id === created.id));
      });

      it("an article with a pending update accepts comments and the page still shows the approved text", async () => {
        const deviceId = newDeviceId();
        assert.strictEqual((await postComment(deviceId, seeded.pendingUpdateId)).status, 201);
        const html = (await getHtml(`/articles/${seeded.pendingUpdateId}`, deviceId)).html;
        assert.ok(html.includes("Approved paragraph one."));
        assert.ok(!html.includes(PENDING_MARKER));
      });
    });

    describe("ownership and forged input", () => {
      it("another device cannot edit or delete a comment, and the comment stays unchanged", async () => {
        const owner = newDeviceId();
        const intruder = newDeviceId();
        const created = (await postComment(owner)).body;

        const edit = await api("PATCH", `/api/public/comments/${created.id}`, { deviceId: intruder, body: { body: "Hijacked" } });
        assert.strictEqual(edit.status, 403);
        const remove = await api("DELETE", `/api/public/comments/${created.id}`, { deviceId: intruder });
        assert.strictEqual(remove.status, 403);
        // A request with no cookie at all is just another new device.
        assert.strictEqual((await api("DELETE", `/api/public/comments/${created.id}`)).status, 403);

        const stored = await Comment.findById(created.id).lean();
        assert.strictEqual(stored.body, "A short comment.");
        const listedForIntruder = (await api("GET", commentsPath(articleId), { deviceId: intruder })).body.items.find((item) => item.id === created.id);
        assert.strictEqual(listedForIntruder.canEdit, false);
        assert.strictEqual(listedForIntruder.canDelete, false);
      });

      it("forged owner, article, date and role fields in a new comment are ignored", async () => {
        const deviceId = newDeviceId();
        const victim = newDeviceId();
        const forged = {
          ...validComment(),
          _id: String(new mongoose.Types.ObjectId()),
          deviceId: victim,
          articleId: otherArticleId,
          createdAt: "2001-01-01T00:00:00.000Z",
          updatedAt: "2001-01-01T00:00:00.000Z",
          role: "editor",
          isOwner: true,
          canEdit: true,
          canDelete: true,
        };
        const response = await api("POST", `${commentsPath(articleId)}?role=editor&deviceId=${victim}`, {
          deviceId,
          body: forged,
          headers: { "x-role": "editor", "x-device-id": victim },
        });
        assert.strictEqual(response.status, 201);
        assert.notStrictEqual(response.body.id, forged._id);
        assert.strictEqual(response.body.articleId, articleId);
        assert.ok(response.body.createdAt > "2020-01-01");

        const stored = await Comment.findById(response.body.id).select("+deviceId").lean();
        assert.strictEqual(stored.deviceId, deviceId);
        assert.strictEqual(String(stored.articleId), articleId);
        assert.strictEqual(await Comment.countDocuments({ deviceId: victim }), 0);
      });

      it("forged fields cannot change anything but the text of an own comment, or give rights over another one", async () => {
        const owner = newDeviceId();
        const intruder = newDeviceId();
        const created = (await postComment(owner)).body;

        const ownEdit = await api("PATCH", `/api/public/comments/${created.id}`, {
          deviceId: owner,
          body: { body: "New text", displayName: "Hacked", articleId: otherArticleId, deviceId: intruder, createdAt: "2001-01-01T00:00:00.000Z", role: "editor" },
        });
        assert.strictEqual(ownEdit.status, 200);
        const stored = await Comment.findById(created.id).select("+deviceId").lean();
        assert.strictEqual(stored.body, "New text");
        assert.strictEqual(stored.displayName, "Dana");
        assert.strictEqual(String(stored.articleId), articleId);
        assert.strictEqual(stored.deviceId, owner);
        assert.strictEqual(stored.createdAt.toISOString(), created.createdAt);

        const forgedRights = { deviceId: intruder, headers: { "x-role": "editor", "x-device-id": owner } };
        assert.strictEqual((await api("PATCH", `/api/public/comments/${created.id}?role=editor&deviceId=${owner}`, { ...forgedRights, body: { body: "x", role: "editor", deviceId: owner, isOwner: true } })).status, 403);
        assert.strictEqual((await api("DELETE", `/api/public/comments/${created.id}?role=editor&deviceId=${owner}`, forgedRights)).status, 403);
        assert.strictEqual((await Comment.findById(created.id).lean()).body, "New text");
      });

      it("the stored device id never appears in an API response or in the HTML", async () => {
        const deviceId = newDeviceId();
        const created = await postComment(deviceId);
        const listed = await api("GET", commentsPath(articleId), { deviceId });
        const edited = await api("PATCH", `/api/public/comments/${created.body.id}`, { deviceId, body: { body: "Edited" } });
        const page = await getHtml(`/articles/${articleId}`, deviceId);
        for (const text of [created.text, listed.text, edited.text, page.html]) {
          assert.ok(!text.includes(deviceId));
          assert.ok(!text.includes("deviceId"));
        }
        const otherView = await getHtml(`/articles/${articleId}`, newDeviceId());
        assert.ok(!otherView.html.includes(deviceId));
      });
    });

    describe("articles that are not public", () => {
      it("a draft-only, missing or malformed article id exposes no comments and accepts none", async () => {
        const deviceId = newDeviceId();
        const missing = String(new mongoose.Types.ObjectId());
        for (const id of [seeded.draftOnlyId, missing, "not-an-id"]) {
          assert.strictEqual((await api("GET", commentsPath(id), { deviceId })).status, 404, `GET ${id}`);
          assert.strictEqual((await postComment(deviceId, id)).status, 404, `POST ${id}`);
        }
        assert.strictEqual(await Comment.countDocuments({ articleId: seeded.draftOnlyId }), 0);
      });

      it("existing comments of a draft-only or missing article cannot be listed, edited or deleted", async () => {
        const deviceId = newDeviceId();
        const missing = String(new mongoose.Types.ObjectId());
        const hidden = await Comment.create([
          { articleId: seeded.draftOnlyId, deviceId, displayName: "Dana", body: "On a draft." },
          { articleId: missing, deviceId, displayName: "Dana", body: "On a missing article." },
        ]);

        assert.strictEqual((await api("GET", commentsPath(seeded.draftOnlyId), { deviceId })).status, 404);
        for (const comment of hidden) {
          // Even the device that wrote the comment gets 404, and the comment stays in the database.
          assert.strictEqual((await api("PATCH", `/api/public/comments/${comment._id}`, { deviceId, body: { body: "changed" } })).status, 404);
          assert.strictEqual((await api("DELETE", `/api/public/comments/${comment._id}`, { deviceId })).status, 404);
        }
        for (const comment of hidden) {
          assert.strictEqual((await Comment.findById(comment._id).lean()).body.startsWith("On a"), true);
        }
        assert.strictEqual((await getHtml(`/articles/${seeded.draftOnlyId}`, deviceId)).status, 404);
        assert.ok(!(await getHtml(`/articles/${seeded.draftOnlyId}`, deviceId)).html.includes("On a draft."));
      });
    });

    describe("rendering", () => {
      it("hostile text is escaped in the article page and the first comments are in the initial HTML", async () => {
        const deviceId = newDeviceId();
        const created = await postComment(deviceId, articleId, { displayName: "<b>Eve</b>", body: `${HOSTILE}\nsecond line` });
        assert.strictEqual(created.status, 201);
        assert.strictEqual(created.body.displayName, "<b>Eve</b>", "the API returns the stored text unchanged");
        assert.match(created.headers.get("content-type"), /application\/json/);

        const { status, html } = await getHtml(`/articles/${articleId}`, deviceId);
        assert.strictEqual(status, 200);
        assert.ok(html.includes("&lt;script&gt;alert(&#34;x&#34;)&lt;/script&gt;"));
        assert.ok(html.includes("&lt;b&gt;Eve&lt;/b&gt;"));
        assert.ok(!html.includes("<script>alert"));
        assert.ok(!html.includes("<img src=x"));
        assert.ok(!html.includes("<b>Eve</b>"));
        assert.ok(html.includes("Approved paragraph one."), "the article content is still in the initial HTML");
      });

      it("Edit and Delete are rendered only for the device's own comments, and the page is not cached publicly", async () => {
        const owner = newDeviceId();
        const created = (await postComment(owner, otherArticleId, validComment({ displayName: "Owner" }))).body;

        const ownView = await fetch(`${baseUrl}/articles/${otherArticleId}`, { headers: cookieHeader(owner) });
        const ownHtml = await ownView.text();
        assert.ok(ownHtml.includes(`data-comment-id="${created.id}"`));
        assert.ok(ownHtml.includes('data-action="edit"') && ownHtml.includes('data-action="delete"'));
        assert.strictEqual(ownView.headers.get("cache-control"), "private, no-cache");

        const strangerHtml = (await getHtml(`/articles/${otherArticleId}`, newDeviceId())).html;
        assert.ok(strangerHtml.includes(`data-comment-id="${created.id}"`));
        assert.ok(!strangerHtml.includes('data-action="edit"') && !strangerHtml.includes('data-action="delete"'));
      });

      it("the comment list response is private and the page has the empty state when there are no comments", async () => {
        const listed = await api("GET", commentsPath(articleId), { deviceId: newDeviceId() });
        assert.strictEqual(listed.headers.get("cache-control"), "private, no-cache");

        const cleanArticle = seeded.unsafeImageId;
        const { html } = await getHtml(`/articles/${cleanArticle}`, newDeviceId());
        assert.ok(html.includes("No comments yet. Be the first to comment."));
        assert.ok(!/id="pub-comments-empty" hidden/.test(html));
      });

      it("if comments cannot be read the article is still served, with a message, and the API gives 500", async () => {
        await withBrokenMethod(Comment, "find", failingFind, async (logged) => {
          const { status, html } = await getHtml(`/articles/${articleId}`, newDeviceId());
          assert.strictEqual(status, 200);
          assert.ok(html.includes("Approved paragraph one."));
          assert.ok(html.includes("Comments are temporarily unavailable."));
          assert.ok(!html.includes("simulated"));
          assert.strictEqual(logged.length, 1);

          const api500 = await api("GET", commentsPath(articleId), { deviceId: newDeviceId() });
          assert.strictEqual(api500.status, 500);
          assert.ok(!api500.text.includes("simulated"));
        });
      });
    });

    describe("pagination", () => {
      let paginationArticleId;
      let expectedIds;

      before(async () => {
        // 25 comments on one article. Dates repeat in groups of five to exercise the _id tie-breaker.
        paginationArticleId = seeded.unsafeImageId;
        await Comment.deleteMany({ articleId: paginationArticleId });
        const base = Date.UTC(2026, 0, 1);
        const documents = [];
        for (let index = 0; index < 25; index += 1) {
          documents.push({
            articleId: paginationArticleId,
            deviceId: newDeviceId(),
            displayName: `Reader ${index}`,
            body: `Comment number ${index}`,
            createdAt: new Date(base + Math.floor(index / 5) * 60000),
            updatedAt: new Date(base + Math.floor(index / 5) * 60000),
          });
        }
        const inserted = await Comment.insertMany(documents, { timestamps: false });
        expectedIds = inserted
          .map((comment) => ({ id: String(comment._id), time: comment.createdAt.getTime() }))
          .sort((first, second) => second.time - first.time || (second.id > first.id ? 1 : -1))
          .map((entry) => entry.id);
      });

      async function readPage(before) {
        const query = before ? `?before=${encodeURIComponent(before)}` : "";
        const response = await api("GET", commentsPath(paginationArticleId) + query, { deviceId: newDeviceId() });
        assert.strictEqual(response.status, 200);
        return response.body;
      }

      it("pages of 10 follow newest first, with ids as the tie-breaker, without duplicates", async () => {
        const first = await readPage();
        const second = await readPage(first.nextBefore);
        const third = await readPage(second.nextBefore);

        assert.deepStrictEqual([first.items.length, second.items.length, third.items.length], [10, 10, 5]);
        assert.deepStrictEqual([first.hasMore, second.hasMore, third.hasMore], [true, true, false]);
        const all = [...first.items, ...second.items, ...third.items];
        assert.deepStrictEqual(all.map((item) => item.id), expectedIds);
        assert.strictEqual(new Set(all.map((item) => item.id)).size, 25);
        for (let index = 1; index < all.length; index += 1) {
          assert.ok(all[index - 1].createdAt >= all[index].createdAt);
        }
        const empty = await readPage(third.nextBefore);
        assert.deepStrictEqual(empty, { items: [], hasMore: false, nextBefore: null });
      });

      it("a comment added or deleted between two pages does not cause a duplicate or a gap", async () => {
        const first = await readPage();
        const newcomer = (await postComment(newDeviceId(), paginationArticleId)).body;
        // Delete the comment that the cursor points at and one already read.
        await Comment.deleteMany({ _id: { $in: [first.items[9].id, first.items[0].id] } });

        const second = await readPage(first.nextBefore);
        assert.deepStrictEqual(second.items.map((item) => item.id), expectedIds.slice(10, 20));
        assert.ok(!second.items.some((item) => item.id === newcomer.id));

        const fresh = await readPage();
        assert.strictEqual(fresh.items[0].id, newcomer.id, "a new comment goes to the top");
        await Comment.deleteOne({ _id: newcomer.id });
      });

      it("the article page renders the first page and the same cursor as the API", async () => {
        const api1 = await readPage();
        const { html } = await getHtml(`/articles/${paginationArticleId}`, newDeviceId());
        const renderedIds = [...html.matchAll(/data-comment-id="([0-9a-f]{24})"/g)].map((match) => match[1]);
        assert.deepStrictEqual(renderedIds, api1.items.map((item) => item.id));
        assert.ok(html.includes(`data-next-before="${api1.nextBefore}"`));
        assert.ok(html.includes('data-has-more="true"'));
        assert.ok(!/id="pub-comments-more" hidden/.test(html));
      });
    });

    describe("limit of 3 new comments per rolling 60 seconds per device", () => {
      it("the first three are created and the fourth is rejected with 429, a message and Retry-After", async () => {
        const deviceId = newDeviceId();
        for (let count = 1; count <= 3; count += 1) {
          assert.strictEqual((await postComment(deviceId)).status, 201, `comment ${count}`);
        }
        const fourth = await postComment(deviceId);
        assert.strictEqual(fourth.status, 429);
        assert.match(fourth.body.error, /at most 3 comments per minute/);
        const retryAfter = Number(fourth.headers.get("retry-after"));
        assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 60);
        assert.strictEqual(fourth.body.retryAfterSeconds, retryAfter);
        assert.strictEqual(await Comment.countDocuments({ displayName: "Dana", body: "A short comment.", deviceId }), 3);
      });

      it("different articles share the same device quota", async () => {
        const deviceId = newDeviceId();
        assert.strictEqual((await postComment(deviceId, articleId)).status, 201);
        assert.strictEqual((await postComment(deviceId, otherArticleId)).status, 201);
        assert.strictEqual((await postComment(deviceId, articleId)).status, 201);
        assert.strictEqual((await postComment(deviceId, otherArticleId)).status, 429);
        assert.strictEqual((await postComment(deviceId, articleId)).status, 429);
      });

      it("devices have independent quotas", async () => {
        const first = newDeviceId();
        const second = newDeviceId();
        for (let count = 0; count < 3; count += 1) {
          await postComment(first);
        }
        assert.strictEqual((await postComment(first)).status, 429);
        for (let count = 0; count < 3; count += 1) {
          assert.strictEqual((await postComment(second)).status, 201);
        }
      });

      it("simultaneous requests cannot exceed the limit", async () => {
        const deviceId = newDeviceId();
        const responses = await Promise.all(
          Array.from({ length: 12 }, (_, index) => postComment(deviceId, index % 2 === 0 ? articleId : otherArticleId))
        );
        const statuses = responses.map((response) => response.status).sort();
        assert.deepStrictEqual(statuses, [201, 201, 201, ...Array(9).fill(429)]);
        assert.strictEqual(await Comment.countDocuments({ deviceId }), 3);
      });

      it("invalid input and nonpublic articles do not use a slot", async () => {
        const deviceId = newDeviceId();
        const invalid = [
          validComment({ displayName: "" }),
          validComment({ body: "  " }),
          validComment({ body: "x".repeat(1001) }),
          validComment({ displayName: 5 }),
          validComment({ body: { $ne: 1 } }),
        ];
        for (const body of invalid) {
          assert.strictEqual((await postComment(deviceId, articleId, body)).status, 400);
        }
        const malformedJson = await fetch(baseUrl + commentsPath(articleId), { method: "POST", headers: { "Content-Type": "application/json", ...cookieHeader(deviceId) }, body: "{oops" });
        assert.strictEqual(malformedJson.status, 400);
        for (const id of [seeded.draftOnlyId, String(new mongoose.Types.ObjectId()), "not-an-id"]) {
          assert.strictEqual((await postComment(deviceId, id)).status, 404);
        }

        for (let count = 0; count < 3; count += 1) {
          assert.strictEqual((await postComment(deviceId)).status, 201, `valid comment ${count + 1}`);
        }
        assert.strictEqual((await postComment(deviceId)).status, 429);
      });

      it("a failed database write releases its slot", async () => {
        const deviceId = newDeviceId();
        await withBrokenMethod(Comment, "create", failingCreate, async (logged) => {
          for (let attempt = 0; attempt < 5; attempt += 1) {
            const response = await postComment(deviceId);
            assert.strictEqual(response.status, 500);
            assert.ok(!response.text.includes("simulated"));
          }
          assert.strictEqual(logged.length, 5);
        });
        assert.strictEqual(await Comment.countDocuments({ deviceId }), 0);

        for (let count = 0; count < 3; count += 1) {
          assert.strictEqual((await postComment(deviceId)).status, 201);
        }
        assert.strictEqual((await postComment(deviceId)).status, 429);
      });

      it("simultaneous failing writes do not leave slots reserved", async () => {
        const deviceId = newDeviceId();
        // The write fails only after a delay, so all 8 requests overlap while their slots are reserved.
        const slowFailingCreate = async () => {
          await new Promise((resolve) => setTimeout(resolve, 300));
          throw new Error("simulated create failure");
        };
        await withBrokenMethod(Comment, "create", slowFailingCreate, async () => {
          const responses = await Promise.all(Array.from({ length: 8 }, () => postComment(deviceId)));
          // Only 3 slots exist, so 3 attempts reach the database and the other 5 are told to wait.
          const statuses = responses.map((response) => response.status);
          assert.strictEqual(statuses.filter((status) => status === 500).length, 3);
          assert.strictEqual(statuses.filter((status) => status === 429).length, 5);
        });
        for (let count = 0; count < 3; count += 1) {
          assert.strictEqual((await postComment(deviceId)).status, 201, `after the failures, comment ${count + 1}`);
        }
      });

      it("editing and deleting do not use a slot and deleting does not give one back", async () => {
        const deviceId = newDeviceId();
        const first = (await postComment(deviceId)).body;
        for (let count = 0; count < 5; count += 1) {
          assert.strictEqual((await api("PATCH", `/api/public/comments/${first.id}`, { deviceId, body: { body: `Edit ${count}` } })).status, 200);
        }
        assert.strictEqual((await postComment(deviceId)).status, 201, "edits did not use a slot");
        assert.strictEqual((await postComment(deviceId)).status, 201);

        assert.strictEqual((await api("DELETE", `/api/public/comments/${first.id}`, { deviceId })).status, 204);
        assert.strictEqual((await postComment(deviceId)).status, 429, "deleting did not free a slot");

        // Editing and deleting still work while posting is blocked.
        const remaining = (await api("GET", commentsPath(articleId), { deviceId })).body.items.filter((item) => item.canEdit);
        assert.ok(remaining.length >= 2);
        assert.strictEqual((await api("PATCH", `/api/public/comments/${remaining[0].id}`, { deviceId, body: { body: "Still editable" } })).status, 200);
        assert.strictEqual((await api("DELETE", `/api/public/comments/${remaining[0].id}`, { deviceId })).status, 204);
      });
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
