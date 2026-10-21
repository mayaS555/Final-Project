// Tests for middleware/errorHandler.js.
// Verifies that bad input, syntax errors, unauthorized access, and unexpected errors
// are safely caught and never crash the server.
// Run: node --test tests/errorHandler.test.js

const { describe, test, before, after } = require("node:test");
const assert = require("assert");
const express = require("express");
const path = require("path");
const {
  errorHandler,
  notFoundHandler,
  normalizeError,
  isJsonRequest,
} = require("../middleware/errorHandler");

describe("normalizeError", () => {
  test("normalizes JSON parsing SyntaxError to 400", () => {
    const err = new SyntaxError("Unexpected token in JSON");
    err.status = 400;
    err.body = "{ bad json";
    const normalized = normalizeError(err);
    assert.equal(normalized.status, 400);
    assert.equal(normalized.message, "The request body is not valid JSON.");
  });

  test("normalizes entity.parse.failed to 400", () => {
    const err = new Error("Parse failed");
    err.type = "entity.parse.failed";
    const normalized = normalizeError(err);
    assert.equal(normalized.status, 400);
    assert.equal(normalized.message, "The request body is not valid JSON.");
  });

  test("normalizes entity.too.large to 413", () => {
    const err = new Error("Too large");
    err.type = "entity.too.large";
    const normalized = normalizeError(err);
    assert.equal(normalized.status, 413);
    assert.equal(normalized.message, "The request payload is too large.");
  });

  test("normalizes URIError to 400", () => {
    const err = new URIError("Failed to decode param");
    const normalized = normalizeError(err);
    assert.equal(normalized.status, 400);
    assert.equal(normalized.message, "Malformed URI sequence in request path.");
  });

  test("normalizes Mongoose ValidationError to 400", () => {
    const err = new Error("Validation failed");
    err.name = "ValidationError";
    err.errors = {
      title: { message: "Title is required." },
      email: { message: "Email is invalid." },
    };
    const normalized = normalizeError(err);
    assert.equal(normalized.status, 400);
    assert.ok(normalized.message.includes("Title is required."));
    assert.ok(normalized.message.includes("Email is invalid."));
  });

  test("normalizes Mongoose CastError to 400", () => {
    const err = new Error("Cast to ObjectId failed");
    err.name = "CastError";
    err.path = "articleId";
    const normalized = normalizeError(err);
    assert.equal(normalized.status, 400);
    assert.equal(normalized.message, "Invalid format for articleId.");
  });

  test("normalizes MongoDB duplicate key error 11000 to 409", () => {
    const err = new Error("E11000 duplicate key error");
    err.code = 11000;
    err.keyValue = { email: "test@example.com" };
    const normalized = normalizeError(err);
    assert.equal(normalized.status, 409);
    assert.equal(normalized.message, "A record with this email already exists.");
  });

  test("preserves existing valid HTTP status codes", () => {
    const err = new Error("Permission denied");
    err.status = 403;
    const normalized = normalizeError(err);
    assert.equal(normalized.status, 403);
    assert.equal(normalized.message, "Permission denied");
  });

  test("handles string/primitive error passed instead of Error object", () => {
    const normalized = normalizeError("Something broke unexpectedly");
    assert.equal(normalized.status, 500);
    assert.equal(normalized.message, "Something broke unexpectedly");
  });

  test("handles null or undefined error safely", () => {
    const normalized = normalizeError(null);
    assert.equal(normalized.status, 500);
    assert.equal(normalized.message, "An unexpected error occurred.");
  });

  test("defaults unknown errors without status to 500", () => {
    const err = new Error("Database connection dropped");
    const normalized = normalizeError(err);
    assert.equal(normalized.status, 500);
    assert.equal(normalized.message, "Database connection dropped");
  });

  test("masks 500 errors in production", () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const err = new Error("Sensitive DB details");
      const normalized = normalizeError(err);
      assert.equal(normalized.status, 500);
      assert.equal(normalized.message, "Internal server error. Please try again later.");
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });
});

describe("isJsonRequest", () => {
  test("returns true for /api/ paths", () => {
    const req = { path: "/api/articles", xhr: false, get: () => "" };
    assert.equal(isJsonRequest(req), true);
  });

  test("returns true for xhr requests", () => {
    const req = { path: "/some/path", xhr: true, get: () => "" };
    assert.equal(isJsonRequest(req), true);
  });

  test("returns true when Accept header specifies application/json", () => {
    const req = {
      path: "/custom",
      xhr: false,
      get: (header) => (header.toLowerCase() === "accept" ? "application/json" : ""),
    };
    assert.equal(isJsonRequest(req), true);
  });

  test("returns false for standard browser page requests", () => {
    const req = {
      path: "/reporter",
      xhr: false,
      get: (header) => (header.toLowerCase() === "accept" ? "text/html,application/xhtml+xml" : ""),
    };
    assert.equal(isJsonRequest(req), false);
  });
});

describe("errorHandler HTTP integration", () => {
  let server;
  let baseUrl;

  before(async () => {
    const app = express();
    app.set("view engine", "ejs");
    app.set("views", path.join(__dirname, "..", "views"));

    // Body parser with 10kb limit to test parsing errors and oversized payloads
    app.use(express.json({ limit: "10kb" }));

    // Mock API routes that produce various errors
    app.post("/api/echo", (req, res) => {
      res.json({ body: req.body });
    });

    app.get("/api/unauthorized", (req, res, next) => {
      const err = new Error("API login required");
      err.status = 401;
      next(err);
    });

    app.get("/api/forbidden", (req, res, next) => {
      const err = new Error("API forbidden");
      err.status = 403;
      next(err);
    });

    app.get("/api/crash", (req, res, next) => {
      next(new Error("Unexpected crash in API route"));
    });

    // Mock HTML routes that produce errors
    app.get("/reporter/dashboard", (req, res, next) => {
      const err = new Error("Please log in.");
      err.status = 401;
      next(err);
    });

    app.get("/editor/dashboard", (req, res, next) => {
      const err = new Error("Editor access only.");
      err.status = 403;
      next(err);
    });

    app.get("/html-crash", (req, res, next) => {
      next(new Error("Unexpected crash in HTML route"));
    });

    // 404 handler
    app.use(notFoundHandler);

    // Error handler
    app.use(errorHandler);

    server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => {
    return new Promise((resolve) => server.close(resolve));
  });

  test("handles malformed JSON body with 400 JSON response", async () => {
    const res = await fetch(`${baseUrl}/api/echo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"invalid": json}',
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.error, "The request body is not valid JSON.");
  });

  test("handles oversized payload with 413 JSON response", async () => {
    const bigData = "a".repeat(15 * 1024); // 15kb > 10kb limit
    const res = await fetch(`${baseUrl}/api/echo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: bigData }),
    });
    assert.equal(res.status, 413);
    const data = await res.json();
    assert.equal(data.error, "The request payload is too large.");
  });

  test("handles 401 on API endpoint with JSON response", async () => {
    const res = await fetch(`${baseUrl}/api/unauthorized`);
    assert.equal(res.status, 401);
    const data = await res.json();
    assert.equal(data.error, "API login required");
  });

  test("handles 403 on API endpoint with JSON response", async () => {
    const res = await fetch(`${baseUrl}/api/forbidden`);
    assert.equal(res.status, 403);
    const data = await res.json();
    assert.equal(data.error, "API forbidden");
  });

  test("handles 401 on HTML page with 302 redirect to login", async () => {
    const res = await fetch(`${baseUrl}/reporter/dashboard`, { redirect: "manual" });
    assert.equal(res.status, 302);
    const location = res.headers.get("Location");
    assert.ok(location.startsWith("/login.html?returnTo="));
    assert.ok(location.includes(encodeURIComponent("/reporter/dashboard")));
  });

  test("handles 403 on HTML page by rendering 403 message page", async () => {
    const res = await fetch(`${baseUrl}/editor/dashboard`);
    assert.equal(res.status, 403);
    const html = await res.text();
    assert.ok(html.includes("Access Denied"));
    assert.ok(html.includes("Editor access only."));
  });

  test("handles 404 for unknown API route with 404 JSON response", async () => {
    const res = await fetch(`${baseUrl}/api/nonexistent`);
    assert.equal(res.status, 404);
    const data = await res.json();
    assert.ok(data.error.includes("Cannot GET /api/nonexistent"));
  });

  test("handles 404 for unknown HTML route with 404 message page", async () => {
    const res = await fetch(`${baseUrl}/nonexistent-page`);
    assert.equal(res.status, 404);
    const html = await res.text();
    assert.ok(html.includes("Page Not Found"));
  });

  test("handles unexpected 500 error on API without crashing server", async () => {
    const res = await fetch(`${baseUrl}/api/crash`);
    assert.equal(res.status, 500);
    const data = await res.json();
    assert.ok(data.error);
  });

  test("handles unexpected 500 error on HTML page without crashing server", async () => {
    const res = await fetch(`${baseUrl}/html-crash`);
    assert.equal(res.status, 500);
    const html = await res.text();
    assert.ok(html.includes("Error 500"));
  });

  test("delegates to next(err) if headers were already sent", () => {
    let nextCalledWith = null;
    const req = { path: "/api/test", xhr: false, get: () => "" };
    const res = { headersSent: true };
    const err = new Error("Headers already committed");
    errorHandler(err, req, res, (passedErr) => {
      nextCalledWith = passedErr;
    });
    assert.equal(nextCalledWith, err);
  });
});
