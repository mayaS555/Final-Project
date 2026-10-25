// Tests for middleware/articleAccess.js (owned by B). No database needed: Article.findById is replaced.
// Run: node --test tests/

const { describe, test, afterEach, mock } = require("node:test");
const assert = require("assert");
const mongoose = require("mongoose");
const Article = require("../models/Article");
const {
  loadArticle,
  requireArticleOwnerOrEditor,
  getSessionUser,
} = require("../middleware/articleAccess");

const authorId = new mongoose.Types.ObjectId();
const reporter = { _id: authorId, role: "reporter", name: "Noa" };
const otherReporter = {
  _id: new mongoose.Types.ObjectId(),
  role: "reporter",
  name: "Dan",
};
const editor = {
  _id: new mongoose.Types.ObjectId(),
  role: "editor",
  name: "Ed",
};
const admin = {
  _id: new mongoose.Types.ObjectId(),
  role: "admin",
  name: "Ada",
};

/**
 * Runs one middleware and returns what it passed to next.
 * @param {Function} middleware The middleware under test.
 * @param {Object} req A fake request.
 * @returns {Promise<*>} The argument given to next (undefined when the request may continue).
 * @example const error = await runMiddleware(loadArticle, { params: { id: "x" } });
 */
async function runMiddleware(middleware, req) {
  let passed = "next was not called";
  await middleware(req, {}, (value) => {
    passed = value;
  });
  return passed;
}

describe("loadArticle", () => {
  afterEach(() => mock.restoreAll());

  test("rejects ids that are not 24 hex characters with 400, without a query", async () => {
    const findById = mock.method(Article, "findById", async () => null);
    for (const id of [
      "abc",
      "12345678901",
      "zzzzzzzzzzzzzzzzzzzzzzzz",
      "a".repeat(25),
      undefined,
    ]) {
      const error = await runMiddleware(loadArticle, { params: { id } });
      assert.equal(error.status, 400, String(id));
    }
    assert.equal(findById.mock.callCount(), 0);
  });

  test("answers 404 for a missing article", async () => {
    mock.method(Article, "findById", async () => null);
    const error = await runMiddleware(loadArticle, {
      params: { id: String(new mongoose.Types.ObjectId()) },
    });
    assert.equal(error.status, 404);
  });

  test("sets req.article and continues", async () => {
    const article = new Article({ author: authorId, authorName: "Noa" });
    mock.method(Article, "findById", async () => article);
    const req = { params: { id: String(article._id) } };
    assert.equal(await runMiddleware(loadArticle, req), undefined);
    assert.equal(req.article, article);
  });

  test("passes database errors to next unchanged", async () => {
    const databaseError = new Error("connection lost");
    mock.method(Article, "findById", async () => {
      throw databaseError;
    });
    const error = await runMiddleware(loadArticle, {
      params: { id: String(new mongoose.Types.ObjectId()) },
    });
    assert.equal(error, databaseError);
  });
});

describe("requireArticleOwnerOrEditor", () => {
  const article = new Article({ author: authorId, authorName: "Noa" });

  test("lets the author, any editor and any admin continue", async () => {
    assert.equal(
      await runMiddleware(requireArticleOwnerOrEditor, {
        article,
        session: { user: reporter },
      }),
      undefined,
    );
    assert.equal(
      await runMiddleware(requireArticleOwnerOrEditor, {
        article,
        session: { user: editor },
      }),
      undefined,
    );
    assert.equal(
      await runMiddleware(requireArticleOwnerOrEditor, {
        article,
        session: { user: admin },
      }),
      undefined,
    );
  });

  test("refuses another reporter with 403", async () => {
    const error = await runMiddleware(requireArticleOwnerOrEditor, {
      article,
      session: { user: otherReporter },
    });
    assert.equal(error.status, 403);
  });

  test("refuses a user with the author's id but no reporter role", async () => {
    const error = await runMiddleware(requireArticleOwnerOrEditor, {
      article,
      session: { user: { _id: authorId, role: "guest" } },
    });
    assert.equal(error.status, 403);
  });

  test("answers 401 when nobody is logged in", async () => {
    assert.equal(
      (await runMiddleware(requireArticleOwnerOrEditor, { article })).status,
      401,
    );
    assert.equal(
      (
        await runMiddleware(requireArticleOwnerOrEditor, {
          article,
          session: {},
        })
      ).status,
      401,
    );
  });

  test("ignores user data sent by the browser", async () => {
    const req = {
      article,
      session: { user: otherReporter },
      body: { author: String(authorId), role: "editor" },
      query: { userId: String(authorId) },
      headers: { "x-user-id": String(authorId) },
    };
    assert.equal(
      (await runMiddleware(requireArticleOwnerOrEditor, req)).status,
      403,
    );
  });
});

test("getSessionUser reads only the session", () => {
  assert.equal(getSessionUser({ session: { user: editor } }), editor);
  assert.equal(getSessionUser({ body: { user: editor } }), null);
  assert.equal(getSessionUser({}), null);
});
