// Tests for services/logger.js.
// Verifies level filtering, formatting, specialized helpers, in-memory buffer,
// request middleware, and that article/auth events produce the expected output.
// Run: node --test tests/logger.test.js

const { describe, test, before, beforeEach, after } = require("node:test");
const assert = require("assert");
const path = require("path");
const express = require("express");

const logger = require("../services/logger");

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

/** Captures console.log / console.warn / console.error output for one call. */
function captureConsole(fn) {
  const lines = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  console.log = (...args) => lines.push({ level: "log", text: args.join(" ") });
  console.warn = (...args) => lines.push({ level: "warn", text: args.join(" ") });
  console.error = (...args) => lines.push({ level: "error", text: args.join(" ") });
  try {
    fn();
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  }
  return lines;
}

// ------------------------------------------------------------------
// Setup / teardown
// ------------------------------------------------------------------

let savedLevel;

before(() => {
  savedLevel = logger.getLevel();
});

beforeEach(() => {
  logger.clearLogs();
  logger.setLevel("debug"); // use maximum verbosity in tests
});

after(() => {
  logger.setLevel(savedLevel);
  logger.clearLogs();
});

// ------------------------------------------------------------------
// Level filtering
// ------------------------------------------------------------------

describe("Level filtering", () => {
  test("debug messages are suppressed at info level", () => {
    logger.setLevel("info");
    const lines = captureConsole(() => logger.debug("should be hidden"));
    assert.equal(lines.length, 0);
    assert.equal(logger.getRecentLogs().length, 0);
  });

  test("info messages are suppressed at warn level", () => {
    logger.setLevel("warn");
    const lines = captureConsole(() => logger.info("should be hidden"));
    assert.equal(lines.length, 0);
  });

  test("warn messages are suppressed at error level", () => {
    logger.setLevel("error");
    const lines = captureConsole(() => logger.warn("should be hidden"));
    assert.equal(lines.length, 0);
  });

  test("all messages are suppressed at silent level", () => {
    logger.setLevel("silent");
    const lines = captureConsole(() => {
      logger.debug("d");
      logger.info("i");
      logger.warn("w");
      logger.error("e");
    });
    assert.equal(lines.length, 0);
  });

  test("an unknown level name is ignored (level stays unchanged)", () => {
    logger.setLevel("info");
    logger.setLevel("INVALID_LEVEL_NAME");
    assert.equal(logger.getLevel(), "info");
  });
});

// ------------------------------------------------------------------
// Output format
// ------------------------------------------------------------------

describe("Output format", () => {
  test("info writes to console.log with timestamp, level, and message", () => {
    const lines = captureConsole(() => logger.info("Hello world"));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].level, "log");
    assert.ok(lines[0].text.includes("[INFO]"), `Expected [INFO] in: ${lines[0].text}`);
    assert.ok(lines[0].text.includes("Hello world"));
    // ISO-8601 timestamp present
    assert.ok(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(lines[0].text));
  });

  test("warn writes to console.warn", () => {
    const lines = captureConsole(() => logger.warn("Something bad might happen"));
    assert.equal(lines[0].level, "warn");
    assert.ok(lines[0].text.includes("[WARN]"));
  });

  test("error writes to console.error with stack trace", () => {
    const err = new Error("DB connection lost");
    const lines = captureConsole(() => logger.error("Storage failure", err));
    assert.equal(lines[0].level, "error");
    assert.ok(lines[0].text.includes("[ERROR]"));
    assert.ok(lines[0].text.includes("Storage failure"));
    assert.ok(lines[0].text.includes("DB connection lost"));
    assert.ok(lines[0].text.includes("Error:")); // stack trace present
  });

  test("metadata key=value pairs are appended to the message", () => {
    const lines = captureConsole(() =>
      logger.info("User action", { userId: "abc123", role: "reporter" })
    );
    assert.ok(lines[0].text.includes("userId=abc123"));
    assert.ok(lines[0].text.includes("role=reporter"));
  });

  test("null or undefined metadata values are omitted", () => {
    const lines = captureConsole(() =>
      logger.info("Sparse metadata", { a: "hello", b: null, c: undefined, d: 42 })
    );
    assert.ok(lines[0].text.includes("a=hello"));
    assert.ok(lines[0].text.includes("d=42"));
    assert.ok(!lines[0].text.includes("b=null"));
    assert.ok(!lines[0].text.includes("c=undefined"));
  });
});

// ------------------------------------------------------------------
// In-memory log buffer
// ------------------------------------------------------------------

describe("In-memory log buffer", () => {
  test("logs are stored and retrievable with getRecentLogs()", () => {
    captureConsole(() => {
      logger.info("first");
      logger.warn("second");
      logger.error("third");
    });
    const logs = logger.getRecentLogs();
    assert.equal(logs.length, 3);
    assert.equal(logs[0].level, "info");
    assert.equal(logs[0].message, "first");
    assert.equal(logs[1].level, "warn");
    assert.equal(logs[2].level, "error");
  });

  test("clearLogs() empties the buffer", () => {
    captureConsole(() => logger.info("will be cleared"));
    logger.clearLogs();
    assert.equal(logger.getRecentLogs().length, 0);
  });

  test("getRecentLogs(limit) returns only the last N entries", () => {
    captureConsole(() => {
      for (let i = 0; i < 10; i++) logger.info(`entry ${i}`);
    });
    const recent = logger.getRecentLogs(3);
    assert.equal(recent.length, 3);
    assert.equal(recent[2].message, "entry 9");
  });

  test("buffer includes error message and stack when an Error is provided", () => {
    const err = new Error("Something broke");
    captureConsole(() => logger.error("Failure", err));
    const entry = logger.getRecentLogs(1)[0];
    assert.equal(entry.error, "Something broke");
    assert.ok(typeof entry.stack === "string");
    assert.ok(entry.stack.includes("Error: Something broke"));
  });

  test("buffer stores metadata on each entry", () => {
    captureConsole(() => logger.info("meta test", { key: "value" }));
    const entry = logger.getRecentLogs(1)[0];
    assert.deepStrictEqual(entry.metadata, { key: "value" });
  });
});

// ------------------------------------------------------------------
// logArticleEvent helper
// ------------------------------------------------------------------

describe("logArticleEvent", () => {
  test("formats the message as [article] <event> article=<id> by=<userId> (<role>)", () => {
    const lines = captureConsole(() =>
      logger.logArticleEvent("submit", "articleId123", "userId456", "reporter")
    );
    assert.ok(lines[0].text.includes("[article] submit"));
    assert.ok(lines[0].text.includes("article=articleId123"));
    assert.ok(lines[0].text.includes("by=userId456"));
    assert.ok(lines[0].text.includes("(reporter)"));
  });

  test("accepts Mongoose documents for articleId and userId (uses _id)", () => {
    const article = { _id: "a1b2c3d4" };
    const user = { _id: "u9x8y7z6" };
    const lines = captureConsole(() =>
      logger.logArticleEvent("approve", article, user, "editor")
    );
    assert.ok(lines[0].text.includes("article=a1b2c3d4"));
    assert.ok(lines[0].text.includes("by=u9x8y7z6"));
    assert.ok(lines[0].text.includes("(editor)"));
  });

  test("appends extra metadata when provided", () => {
    const lines = captureConsole(() =>
      logger.logArticleEvent("return", "art1", "usr1", "editor", { note: "spelling errors" })
    );
    assert.ok(lines[0].text.includes("note=spelling errors"));
  });
});

// ------------------------------------------------------------------
// logAuthEvent helper
// ------------------------------------------------------------------

describe("logAuthEvent", () => {
  test("login_success is logged at info level", () => {
    const lines = captureConsole(() =>
      logger.logAuthEvent("login_success", { userId: "u1", role: "reporter" })
    );
    assert.ok(lines[0].text.includes("[INFO]"));
    assert.ok(lines[0].text.includes("[AUTH] login_success"));
  });

  test("login_failed_bad_password is logged at warn level", () => {
    const lines = captureConsole(() =>
      logger.logAuthEvent("login_failed_bad_password", { email: "user@example.com" })
    );
    assert.equal(lines[0].level, "warn");
    assert.ok(lines[0].text.includes("[AUTH] login_failed_bad_password"));
  });

  test("unauthorized_access is logged at warn level", () => {
    const lines = captureConsole(() =>
      logger.logAuthEvent("unauthorized_access", { path: "/reporter" })
    );
    assert.equal(lines[0].level, "warn");
  });

  test("logout is logged at info level", () => {
    const lines = captureConsole(() =>
      logger.logAuthEvent("logout", { userId: "u2" })
    );
    assert.ok(lines[0].text.includes("[INFO]"));
  });
});

// ------------------------------------------------------------------
// logServerEvent helper
// ------------------------------------------------------------------

describe("logServerEvent", () => {
  test("server start event is logged at info level with port", () => {
    const lines = captureConsole(() =>
      logger.logServerEvent("start", { port: 3000, env: "development" })
    );
    assert.ok(lines[0].text.includes("[INFO]"));
    assert.ok(lines[0].text.includes("[SERVER] start"));
    assert.ok(lines[0].text.includes("port=3000"));
  });

  test("db_connected event includes db name", () => {
    const lines = captureConsole(() =>
      logger.logServerEvent("db_connected", { db: "daily-web" })
    );
    assert.ok(lines[0].text.includes("db=daily-web"));
  });
});

// ------------------------------------------------------------------
// requestLogger middleware
// ------------------------------------------------------------------

describe("requestLogger middleware (HTTP integration)", () => {
  let server;
  let baseUrl;

  before(async () => {
    logger.setLevel("debug");
    const app = express();
    app.use(logger.requestLogger());

    app.get("/api/hello", (req, res) => res.json({ ok: true }));
    app.get("/page", (req, res) => res.status(200).send("<h1>hello</h1>"));
    app.get("/missing", (req, res) => res.status(404).send("Not found"));
    app.get("/broken", (req, res) => res.status(500).send("Server error"));
    // Simulate static file
    app.get("/css/style.css", (req, res) => res.status(200).send("body{}"));

    server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  test("logs API requests with method, path, status code, and duration", async () => {
    logger.clearLogs();
    await fetch(`${baseUrl}/api/hello`);
    // Give the 'finish' event time to fire
    await new Promise((r) => setImmediate(r));
    const logs = logger.getRecentLogs();
    const entry = logs.find((l) => l.message.includes("/api/hello"));
    assert.ok(entry, "No log entry found for /api/hello");
    assert.ok(entry.message.includes("GET"));
    assert.ok(entry.message.includes("200"));
    assert.ok(entry.message.includes("ms)"));
  });

  test("logs 4xx responses at warn level", async () => {
    logger.clearLogs();
    await fetch(`${baseUrl}/missing`);
    await new Promise((r) => setImmediate(r));
    const logs = logger.getRecentLogs();
    const entry = logs.find((l) => l.message.includes("/missing"));
    assert.ok(entry);
    assert.equal(entry.level, "warn");
  });

  test("logs 5xx responses at error level", async () => {
    logger.clearLogs();
    await fetch(`${baseUrl}/broken`);
    await new Promise((r) => setImmediate(r));
    const logs = logger.getRecentLogs();
    const entry = logs.find((l) => l.message.includes("/broken"));
    assert.ok(entry);
    assert.equal(entry.level, "error");
  });

  test("suppresses static asset requests at info level by default", async () => {
    logger.setLevel("info");
    logger.clearLogs();
    await fetch(`${baseUrl}/css/style.css`);
    await new Promise((r) => setImmediate(r));
    const logs = logger.getRecentLogs();
    const entry = logs.find((l) => l.message && l.message.includes("style.css"));
    assert.ok(!entry, "Static asset should not be logged at info level");
    logger.setLevel("debug");
  });
});
