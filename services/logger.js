// Central logging service for The Daily Web.
// Formats and logs server lifecycle, authentication, article workflow, HTTP requests,
// and errors. Supports level filtering, structured metadata, and optional file persistence.

const fs = require("fs");
const path = require("path");

const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

// Default log level: "error" in test environments to keep test runs clean; "info" otherwise.
let currentLevelName = (
  process.env.LOG_LEVEL || (process.env.NODE_ENV === "test" ? "error" : "info")
).toLowerCase();
let currentLevel =
  LOG_LEVELS[currentLevelName] !== undefined
    ? LOG_LEVELS[currentLevelName]
    : LOG_LEVELS.info;

// Optional file logging configuration
const LOG_TO_FILE = process.env.LOG_TO_FILE === "true";
const LOG_DIR = path.join(__dirname, "..", "logs");
let logStream = null;
let errorStream = null;

if (LOG_TO_FILE) {
  try {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }
    logStream = fs.createWriteStream(path.join(LOG_DIR, "app.log"), {
      flags: "a",
    });
    errorStream = fs.createWriteStream(path.join(LOG_DIR, "error.log"), {
      flags: "a",
    });
  } catch (err) {
    console.error(
      "[Logger] Could not initialize file logging streams:",
      err.message,
    );
  }
}

// In-memory buffer for recent log entries (useful for diagnostics and unit tests)
const MAX_IN_MEMORY_LOGS = 200;
const inMemoryLogs = [];

/**
 * Sets the active log level.
 * @param {"debug"|"info"|"warn"|"error"|"silent"} level The new log level name.
 */
function setLevel(level) {
  const normalized = String(level).toLowerCase();
  if (LOG_LEVELS[normalized] !== undefined) {
    currentLevelName = normalized;
    currentLevel = LOG_LEVELS[normalized];
  }
}

/**
 * Returns the current log level name.
 * @returns {string} The active log level.
 */
function getLevel() {
  return currentLevelName;
}

/**
 * Formats structured metadata into a string.
 * @param {Object} [meta] Key-value metadata.
 * @returns {string} Formatted metadata string or empty string.
 */
function formatMeta(meta) {
  if (!meta || typeof meta !== "object" || Object.keys(meta).length === 0) {
    return "";
  }
  const parts = [];
  for (const [key, value] of Object.entries(meta)) {
    if (value !== undefined && value !== null) {
      if (typeof value === "object") {
        try {
          parts.push(`${key}=${JSON.stringify(value)}`);
        } catch {
          parts.push(`${key}=[Object]`);
        }
      } else {
        parts.push(`${key}=${value}`);
      }
    }
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

/**
 * Internal logging dispatcher. Formats the entry, records it in memory,
 * writes to stdout/stderr, and appends to log files if configured.
 * @param {string} levelName "debug" | "info" | "warn" | "error"
 * @param {string} message The main log message.
 * @param {Error|Object|null} [err] Error object or metadata.
 * @param {Object} [meta] Additional metadata.
 */
function log(levelName, message, err, meta) {
  const levelValue = LOG_LEVELS[levelName];
  if (levelValue === undefined || levelValue < currentLevel) {
    return;
  }

  const timestamp = new Date().toISOString();
  let errorObj = null;
  let metadataObj = meta || {};

  if (err instanceof Error) {
    errorObj = err;
  } else if (err && typeof err === "object") {
    metadataObj = { ...err, ...metadataObj };
  }

  const metaStr = formatMeta(metadataObj);
  let formatted = `[${timestamp}] [${levelName.toUpperCase()}] ${message}${metaStr}`;

  if (errorObj) {
    formatted += `\n${errorObj.stack || errorObj.message}`;
  }

  // Record into circular in-memory buffer
  inMemoryLogs.push({
    timestamp,
    level: levelName,
    message,
    metadata: metadataObj,
    error: errorObj ? errorObj.message : null,
    stack: errorObj ? errorObj.stack : null,
  });
  if (inMemoryLogs.length > MAX_IN_MEMORY_LOGS) {
    inMemoryLogs.shift();
  }

  // Write to console
  if (levelName === "error") {
    console.error(formatted);
  } else if (levelName === "warn") {
    console.warn(formatted);
  } else {
    console.log(formatted);
  }

  // Write to file streams if enabled
  if (logStream && !logStream.destroyed) {
    logStream.write(formatted + "\n");
  }
  if (levelName === "error" && errorStream && !errorStream.destroyed) {
    errorStream.write(formatted + "\n");
  }
}

/**
 * Logs an informational message.
 * @param {string} message The log message.
 * @param {Object} [meta] Structured metadata.
 */
function info(message, meta) {
  log("info", message, null, meta);
}

/**
 * Logs a warning message.
 * @param {string} message The log message.
 * @param {Object} [meta] Structured metadata.
 */
function warn(message, meta) {
  log("warn", message, null, meta);
}

/**
 * Logs a debug message.
 * @param {string} message The log message.
 * @param {Object} [meta] Structured metadata.
 */
function debug(message, meta) {
  log("debug", message, null, meta);
}

/**
 * Logs an error with stack trace and optional metadata.
 * @param {string} message The log message.
 * @param {Error|any} [error] Error instance.
 * @param {Object} [meta] Structured metadata.
 */
function error(message, err, meta) {
  log("error", message, err, meta);
}

/**
 * Specialized logger for Article workflow events as specified in Person B integration contract:
 * `[article] <event> article=<id> by=<user id> (<role>)`
 * @param {string} event Event name ("submit", "approve", "return", "delete", "revise").
 * @param {string|Object} articleId Article ObjectId or document.
 * @param {string|Object} userId Acting user ObjectId or document.
 * @param {string} role User role ("reporter", "editor", "admin").
 * @param {Object} [extra] Extra metadata (e.g. note, publishCount).
 */
function logArticleEvent(event, articleId, userId, role, extra) {
  const aId = articleId && articleId._id ? articleId._id : articleId;
  const uId = userId && userId._id ? userId._id : userId;
  const extraStr = formatMeta(extra);
  const msg = `[article] ${event} article=${aId} by=${uId} (${role})${extraStr}`;
  info(msg);
}

/**
 * Specialized logger for Authentication & Security events.
 * @param {string} event Event description ("login_success", "login_failure", "logout", "unauthorized_access").
 * @param {Object} [meta] Relevant metadata (email, userId, role, ip, path, reason).
 */
function logAuthEvent(event, meta) {
  const isFailure =
    event.includes("fail") ||
    event.includes("unauthorized") ||
    event.includes("forbidden");
  const msg = `[AUTH] ${event}`;
  if (isFailure) {
    warn(msg, meta);
  } else {
    info(msg, meta);
  }
}

/**
 * Specialized logger for Server Lifecycle events.
 * @param {string} event Event description ("start", "db_connected", "indexes_ready", "shutdown").
 * @param {Object} [meta] Relevant metadata (port, dbName, error).
 */
function logServerEvent(event, meta) {
  info(`[SERVER] ${event}`, meta);
}

/**
 * Express middleware to log incoming HTTP requests and responses.
 * Records method, URL, HTTP status code, duration in milliseconds, and authenticated user.
 * Quiets static assets to reduce log noise.
 * @returns {Function} Express middleware (req, res, next).
 */
function requestLogger() {
  return function (req, res, next) {
    // Skip noisy static asset requests (.css, .js, .ico, .png, .jpg) unless level is debug
    const isStatic =
      req.path.startsWith("/css/") ||
      req.path.startsWith("/js/") ||
      /\.(css|js|ico|png|jpg|svg)$/.test(req.path);
    if (isStatic && currentLevel > LOG_LEVELS.debug) {
      return next();
    }

    const startHrTime = process.hrtime.bigint();

    res.on("finish", () => {
      const durationNs = process.hrtime.bigint() - startHrTime;
      const durationMs = (Number(durationNs) / 1e6).toFixed(2);
      const status = res.statusCode;

      const user =
        req.session && req.session.user
          ? ` user=${req.session.user._id}(${req.session.user.role})`
          : "";
      const msg = `[HTTP] ${req.method} ${req.originalUrl || req.url} ${status} (${durationMs}ms)${user}`;

      if (status >= 500) {
        error(msg);
      } else if (status >= 400) {
        warn(msg);
      } else {
        info(msg);
      }
    });

    next();
  };
}

/**
 * Returns recent in-memory log entries.
 * @param {number} [limit=50] Maximum number of entries to return.
 * @returns {Array<Object>} Recent logs.
 */
function getRecentLogs(limit = 50) {
  return inMemoryLogs.slice(-limit);
}

/**
 * Clears the in-memory log buffer (useful in tests).
 */
function clearLogs() {
  inMemoryLogs.length = 0;
}

module.exports = {
  LOG_LEVELS,
  setLevel,
  getLevel,
  debug,
  info,
  warn,
  error,
  logArticleEvent,
  logAuthEvent,
  logServerEvent,
  requestLogger,
  getRecentLogs,
  clearLogs,
};
