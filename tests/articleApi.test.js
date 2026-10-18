// HTTP tests for routes/articleApiRoutes.js and controllers/articleApiController.js (owned by B).
// A small Express app stands in for A's server: a fake session (the user named in the X-Test-User
// header; test code only) and a JSON error handler. Checks that fail before the database run without
// MongoDB; the rest need MONGODB_TEST_URI (see tests/testDatabase.js).
// Run: node --test tests/

const { describe, test, before, after, mock } = require("node:test");
const assert = require("assert");
const express = require("express");
const mongoose = require("mongoose");
const Article = require("../models/Article");
const articleApiRoutes = require("../routes/articleApiRoutes");
const { skipWithoutDatabase, connectTestDatabase, disconnectTestDatabase } = require("./testDatabase");

const USERS = {
  noa: { _id: new mongoose.Types.ObjectId(), role: "reporter", name: "Noa" },
  dan: { _id: new mongoose.Types.ObjectId(), role: "reporter", name: "Dan" },
  ed: { _id: new mongoose.Types.ObjectId(), role: "editor", name: "Ed" },
  guest: { _id: new mongoose.Types.ObjectId(), role: "guest", name: "Guest" },
};

let server;
let baseUrl;

/**
 * Starts the test app on a free port.
 * @returns {Promise<void>} Resolves when it listens; sets baseUrl.
 * @example before(startServer);
 */
async function startServer() {
  const app = express();
  app.use((req, res, next) => {
    req.session = { user: USERS[req.get("X-Test-User")] };
    next();
  });
  app.use(articleApiRoutes);
  // Stand-in for A's error middleware.
  app.use((error, req, res, next) => {
    res.status(error.status || 500).json({ error: error.message });
  });
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

/**
 * Stops the test app.
 * @returns {Promise<void>} Resolves when closed.
 * @example after(stopServer);
 */
function stopServer() {
  return new Promise((resolve) => server.close(resolve));
}

/**
 * Sends one request to the API.
 * @param {string} method HTTP method.
 * @param {string} path Path, for example "/api/articles".
 * @param {{ user?: string, body?: *, contentType?: string }} [options] Who is logged in (a USERS key),
 *   the JSON body, and the content type (application/json by default when a body or a write is sent).
 * @returns {Promise<{ status: number, body: * }>} The status and the parsed JSON (null for 204).
 * @example const { status, body } = await call("POST", "/api/articles", { user: "noa" });
 */
async function call(method, path, { user, body, contentType } = {}) {
  const headers = {};
  if (user) {
    headers["X-Test-User"] = user;
  }
  const isWrite = method !== "GET" && method !== "DELETE";
  if (contentType || isWrite) {
    headers["Content-Type"] = contentType || "application/json";
  }
  const response = await fetch(baseUrl + path, {
    method,
    headers,
    body: isWrite ? (typeof body === "string" ? body : JSON.stringify(body || {})) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

const someId = String(new mongoose.Types.ObjectId());

describe("checks before the database (no MongoDB needed)", () => {
  before(startServer);
  after(stopServer);

  test("every route answers 401 without a login", async () => {
    const routes = [
      ["POST", "/api/articles"],
      ["GET", "/api/articles"],
      ["GET", `/api/articles/${someId}`],
      ["PATCH", `/api/articles/${someId}`],
      ["DELETE", `/api/articles/${someId}`],
      ["POST", `/api/articles/${someId}/submit`],
      ["POST", `/api/articles/${someId}/revise`],
    ];
    for (const [method, path] of routes) {
      assert.equal((await call(method, path)).status, 401, `${method} ${path}`);
    }
  });

  test("a user who is neither reporter nor editor gets 403", async () => {
    assert.equal((await call("GET", "/api/articles", { user: "guest" })).status, 403);
  });

  test("writes that are not JSON get 415", async () => {
    const form = { user: "noa", body: "title=x", contentType: "application/x-www-form-urlencoded" };
    assert.equal((await call("POST", "/api/articles", form)).status, 415);
    assert.equal((await call("PATCH", `/api/articles/${someId}`, form)).status, 415);
    assert.equal((await call("POST", `/api/articles/${someId}/submit`, form)).status, 415);
  });

  test("a JSON write without a body passes the content-type check", async () => {
    const response = await fetch(`${baseUrl}/api/articles/not-an-id/submit`, {
      method: "POST",
      headers: { "X-Test-User": "noa", "Content-Type": "application/json; charset=utf-8" },
    });
    assert.equal(response.status, 400); // reached loadArticle, not 415
  });

  test("malformed JSON gets 400", async () => {
    assert.equal((await call("PATCH", `/api/articles/${someId}`, { user: "noa", body: "{bad" })).status, 400);
  });

  test("an invalid id gets 400", async () => {
    assert.equal((await call("GET", "/api/articles/not-an-id", { user: "noa" })).status, 400);
  });

  test("an unknown or repeated status filter gets 400", async () => {
    assert.equal((await call("GET", "/api/articles?status=live", { user: "noa" })).status, 400);
    assert.equal((await call("GET", "/api/articles?status=draft&status=pending", { user: "noa" })).status, 400);
  });
});

describe("Article API with MongoDB", { skip: skipWithoutDatabase }, () => {
  before(async () => {
    await connectTestDatabase();
    await startServer();
    mock.method(console, "log", () => {});
  });

  after(async () => {
    mock.restoreAll();
    await stopServer();
    await disconnectTestDatabase();
  });

  /**
   * Creates a draft for a reporter and fills in a complete working copy through the API.
   * @param {string} user A USERS key.
   * @returns {Promise<string>} The new article id.
   * @example const id = await createCompleteDraft("noa");
   */
  async function createCompleteDraft(user) {
    const created = await call("POST", "/api/articles", { user });
    const fields = { title: `Harbor report by ${user}`, content: "First\n\nSecond", category: "Sports" };
    await call("PATCH", `/api/articles/${created.body.id}`, { user, body: fields });
    return created.body.id;
  }

  test("POST /api/articles creates an empty draft for a reporter, not for an editor", async () => {
    const created = await call("POST", "/api/articles", { user: "noa" });
    assert.equal(created.status, 201);
    assert.equal(created.body.status, "draft");
    assert.equal(created.body.authorName, "Noa");
    assert.equal(created.body.approved, null);
    assert.equal((await call("POST", "/api/articles", { user: "ed" })).status, 403);
  });

  test("GET /api/articles/:id: the author and an editor read it, another reporter gets 403", async () => {
    const id = await createCompleteDraft("noa");
    const own = await call("GET", `/api/articles/${id}`, { user: "noa" });
    assert.equal(own.status, 200);
    assert.equal(own.body.draft.title, "Harbor report by noa");
    assert.equal((await call("GET", `/api/articles/${id}`, { user: "ed" })).status, 200);
    assert.equal((await call("GET", `/api/articles/${id}`, { user: "dan" })).status, 403);
    assert.equal((await call("GET", `/api/articles/${someId}`, { user: "noa" })).status, 404);
  });

  test("PATCH saves the working copy and returns only savedAt", async () => {
    const id = await createCompleteDraft("noa");
    const saved = await call("PATCH", `/api/articles/${id}`, { user: "noa", body: { summary: "Short" } });
    assert.equal(saved.status, 200);
    assert.deepEqual(Object.keys(saved.body), ["savedAt"]);
    assert.ok(!Number.isNaN(Date.parse(saved.body.savedAt)));
  });

  test("PATCH refuses another reporter (403), unknown keys (400) and a bad category (400)", async () => {
    const id = await createCompleteDraft("noa");
    assert.equal((await call("PATCH", `/api/articles/${id}`, { user: "dan", body: { title: "Mine now" } })).status, 403);
    assert.equal((await call("PATCH", `/api/articles/${id}`, { user: "noa", body: { status: "published" } })).status, 400);
    assert.equal((await call("PATCH", `/api/articles/${id}`, { user: "noa", body: { category: "Gossip" } })).status, 400);
    const stored = await Article.findById(id);
    assert.equal(stored.draft.title, "Harbor report by noa");
    assert.equal(stored.status, "draft");
  });

  test("submit, then illegal transitions get 409 and locked edits get 403", async () => {
    const id = await createCompleteDraft("noa");
    const submitted = await call("POST", `/api/articles/${id}/submit`, { user: "noa" });
    assert.equal(submitted.status, 200);
    assert.equal(submitted.body.status, "pending");

    assert.equal((await call("POST", `/api/articles/${id}/submit`, { user: "noa" })).status, 409);
    assert.equal((await call("POST", `/api/articles/${id}/revise`, { user: "noa" })).status, 409);
    assert.equal((await call("PATCH", `/api/articles/${id}`, { user: "noa", body: { title: "x" } })).status, 403);
  });

  test("submit refuses an incomplete article (400) and another reporter (403)", async () => {
    const created = await call("POST", "/api/articles", { user: "noa" });
    assert.equal((await call("POST", `/api/articles/${created.body.id}/submit`, { user: "noa" })).status, 400);
    const id = await createCompleteDraft("noa");
    assert.equal((await call("POST", `/api/articles/${id}/submit`, { user: "dan" })).status, 403);
  });

  test("revise reopens a published article as a draft", async () => {
    const id = await createCompleteDraft("noa");
    await call("POST", `/api/articles/${id}/submit`, { user: "noa" });
    // Approval is D's route; the test calls the service directly.
    await require("../services/articleService").approve(await Article.findById(id), USERS.ed);

    const revised = await call("POST", `/api/articles/${id}/revise`, { user: "noa" });
    assert.equal(revised.status, 200);
    assert.equal(revised.body.status, "draft");
    assert.equal(revised.body.approved.title, "Harbor report by noa");
    assert.equal(revised.body.draft.title, "Harbor report by noa");
  });

  test("GET /api/articles: reporters see their own, editors see all, status filters", async () => {
    await Article.deleteMany({});
    const noaDraft = await createCompleteDraft("noa");
    const noaPending = await createCompleteDraft("noa");
    await call("POST", `/api/articles/${noaPending}/submit`, { user: "noa" });
    const danDraft = await createCompleteDraft("dan");

    const noaList = await call("GET", "/api/articles", { user: "noa" });
    assert.deepEqual(noaList.body.items.map((item) => item.id).sort(), [noaDraft, noaPending].sort());
    assert.deepEqual(Object.keys(noaList.body.items[0]).sort(), [
      "editorNote",
      "id",
      "publicTitle",
      "publishedAt",
      "status",
      "title",
      "updatedAt",
    ]);

    const editorList = await call("GET", "/api/articles", { user: "ed" });
    assert.equal(editorList.body.items.length, 3);
    const pendingList = await call("GET", "/api/articles?status=pending", { user: "ed" });
    assert.deepEqual(pendingList.body.items.map((item) => item.id), [noaPending]);
    const danList = await call("GET", "/api/articles", { user: "dan" });
    assert.deepEqual(danList.body.items.map((item) => item.id), [danDraft]);
  });

  test("DELETE: the author deletes a draft (204), another reporter gets 403", async () => {
    const id = await createCompleteDraft("noa");
    assert.equal((await call("DELETE", `/api/articles/${id}`, { user: "dan" })).status, 403);
    assert.equal((await call("DELETE", `/api/articles/${id}`, { user: "noa" })).status, 204);
    assert.equal((await call("GET", `/api/articles/${id}`, { user: "noa" })).status, 404);
  });
});
