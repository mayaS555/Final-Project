// DEVELOPMENT ONLY. Integration checks against a real MongoDB through the dev database.
// Needs DEV_MONGODB_URI in .env. Without it every check is SKIPPED, which is not a pass.
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
const { seedDevArticles, PENDING_MARKER, DRAFT_MARKER, SSR_END_MARKER } = require("../seed-public");

const skip = process.env.DEV_MONGODB_URI ? false : "DEV_MONGODB_URI is not set: MongoDB integration checks were NOT run";

function countCards(html) {
  return (html.match(/class="pub-card"/g) || []).length;
}

describe("public feed and article page against dev MongoDB", { skip }, () => {
  let server;
  let baseUrl;
  let seeded;

  before(async () => {
    await connectDevDb();
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

  it("the last page has the remaining items and hasMore false", async () => {
    const { body } = await getJson("/api/public/articles?page=2");
    assert.strictEqual(body.items.length, seeded.approvedCount - FEED_PAGE_SIZE);
    assert.strictEqual(body.hasMore, false);

    const beyond = await getJson("/api/public/articles?page=3");
    assert.deepStrictEqual(beyond.body.items, []);
    assert.strictEqual(beyond.body.hasMore, false);
  });

  it("pages have no duplicates and are ordered by date, then by id, newest first", async () => {
    const first = (await getJson("/api/public/articles?page=1")).body.items;
    const second = (await getJson("/api/public/articles?page=2")).body.items;
    const all = [...first, ...second];
    assert.strictEqual(new Set(all.map((item) => item.id)).size, all.length);

    let equalDatePairs = 0;
    for (let index = 1; index < all.length; index += 1) {
      const previous = all[index - 1];
      const current = all[index];
      assert.ok(previous.publishedAt >= current.publishedAt);
      if (previous.publishedAt === current.publishedAt) {
        equalDatePairs += 1;
        // Same date: the query sorts _id descending. Equal-length hex ids compare like ObjectIds.
        assert.ok(previous.id > current.id, `ids ${previous.id} and ${current.id} are not in descending order`);
      }
    }
    // The seed repeats dates in groups of three, so a pass here must not be vacuous.
    assert.ok(equalDatePairs > 0, "the seed data contains no equal publication dates");
  });

  it("a pending update never replaces or leaks into the approved version (JSON)", async () => {
    const { body } = await getJson("/api/public/articles");
    const item = body.items.find((entry) => entry.id === seeded.pendingUpdateId);
    assert.ok(item, "the article with a pending update stays public");
    assert.strictEqual(item.title, "Approved version: city opens new library");
    for (const page of ["1", "2"]) {
      const text = JSON.stringify((await getJson(`/api/public/articles?page=${page}`)).body);
      assert.ok(!text.includes(PENDING_MARKER));
      assert.ok(!text.includes(DRAFT_MARKER));
      assert.ok(!text.includes("pending.jpg"));
    }
  });

  it("home page renders 20 cards on page 1 and no hidden text", async () => {
    const page1 = await (await fetch(`${baseUrl}/`)).text();
    assert.strictEqual(countCards(page1), FEED_PAGE_SIZE);
    assert.ok(page1.includes("Approved version: city opens new library"));
    assert.ok(page1.includes("/?page=2"));
    assert.ok(!page1.includes(PENDING_MARKER));
    assert.ok(!page1.includes(DRAFT_MARKER));

    const page2 = await (await fetch(`${baseUrl}/?page=2`)).text();
    assert.strictEqual(countCards(page2), seeded.approvedCount - FEED_PAGE_SIZE);
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
