// Centralized error handling and 404 middlewares.
// Catches syntax errors, bad input, validation errors, and unauthorized requests,
// ensuring the server never crashes on unexpected or invalid input.

const logger = require("../services/logger");

/**
 * Determines whether a request expects a JSON response.
 * @param {import("express").Request} req The incoming Express request.
 * @returns {boolean} True if the request is for an API route or expects JSON.
 */
function isJsonRequest(req) {
  if (req.path.startsWith("/api/")) {
    return true;
  }
  if (req.xhr) {
    return true;
  }
  const accept = req.get("Accept") || "";
  if (accept.includes("application/json") && !accept.includes("text/html")) {
    return true;
  }
  return false;
}

/**
 * Normalizes an error object into a status code and safe message.
 * Handles JSON parsing errors, body-parser limits, malformed URIs,
 * Mongoose validation/cast errors, and MongoDB duplicate key conflicts.
 * @param {Error|any} err The raw error.
 * @returns {{ status: number, message: string }} Normalized HTTP status and message.
 */
function normalizeError(err) {
  // Handle non-object / primitive errors (e.g. throw "string error" or next("string error"))
  if (!err || typeof err !== "object") {
    const isString = typeof err === "string" && err.trim().length > 0;
    return {
      status: 500,
      message: isString ? err : "An unexpected error occurred.",
    };
  }

  let status = parseInt(err.status || err.statusCode, 10);
  if (isNaN(status) || status < 400 || status > 599) {
    status = 500;
  }

  let message = err.message || "An unexpected error occurred.";

  // JSON parsing error (SyntaxError from express.json / body-parser)
  if (err.type === "entity.parse.failed" || (err instanceof SyntaxError && status === 400 && "body" in err)) {
    status = 400;
    message = "The request body is not valid JSON.";
  } else if (err.type === "entity.too.large") {
    // Request body exceeds configured limit
    status = 413;
    message = "The request payload is too large.";
  } else if (err instanceof URIError) {
    // Invalid percent-encoding in URL parameters
    status = 400;
    message = "Malformed URI sequence in request path.";
  } else if (err.name === "ValidationError") {
    // Mongoose schema validation failure
    status = 400;
    if (err.errors && typeof err.errors === "object") {
      message = Object.values(err.errors)
        .map((fieldErr) => fieldErr.message)
        .join(" ");
    }
  } else if (err.name === "CastError") {
    // Mongoose type casting failure (e.g. invalid ObjectId format)
    status = 400;
    message = `Invalid format for ${err.path || "identifier"}.`;
  } else if (err.code === 11000) {
    // MongoDB duplicate key error
    status = 409;
    const key = err.keyValue ? Object.keys(err.keyValue)[0] : "field";
    message = `A record with this ${key} already exists.`;
  }

  // Hide internal server details in production
  if (status === 500 && process.env.NODE_ENV === "production") {
    message = "Internal server error. Please try again later.";
  }

  return { status, message };
}

/**
 * Express error-handling middleware (4 arguments).
 * @param {Error|any} err The error passed via next(err) or thrown in an async handler.
 * @param {import("express").Request} req The Express request.
 * @param {import("express").Response} res The Express response.
 * @param {import("express").NextFunction} next The Express next callback.
 * @returns {void}
 */
function errorHandler(err, req, res, next) {
  // If response headers have already been sent, delegate to Express to avoid ERR_HTTP_HEADERS_SENT
  if (res.headersSent) {
    return next(err);
  }

  const { status, message } = normalizeError(err);

  const context = {
    status,
    ip: req.ip,
    user: req.session?.user ? req.session.user._id : undefined,
  };

  if (status >= 500) {
    logger.error(`[HTTP ${status}] ${req.method} ${req.originalUrl || req.url} - ${message}`, err, context);
  } else if (status === 401 || status === 403) {
    logger.warn(`[AUTH ${status}] ${req.method} ${req.originalUrl || req.url} - ${message}`, context);
  } else {
    logger.warn(`[HTTP ${status}] ${req.method} ${req.originalUrl || req.url} - ${message}`, context);
  }

  // API or JSON clients receive structured JSON error payloads
  if (isJsonRequest(req)) {
    return res.status(status).json({ error: message });
  }

  // Redirect unauthenticated visitors attempting to view protected pages (e.g., reporter/editor)
  if (status === 401) {
    // Prevent open-redirect vulnerability: ensure returnTo is a relative path
    const rawUrl = req.originalUrl || "/";
    const safeReturnTo = rawUrl.startsWith("/") && !rawUrl.startsWith("//") ? rawUrl : "/";
    return res.redirect(`/login.html?returnTo=${encodeURIComponent(safeReturnTo)}`);
  }

  // User-facing HTML error page rendered via EJS
  const title =
    status === 403
      ? "Access Denied"
      : status === 404
      ? "Page Not Found"
      : status === 400
      ? "Bad Request"
      : `Error ${status}`;

  res.status(status).render("public/message", { pageTitle: title, title, message }, (renderError, html) => {
    if (renderError) {
      console.error("[RenderError] Failed to render error page:", renderError);
      return res.status(status).type("text/html").send(`<!DOCTYPE html><html><head><title>${title}</title></head><body><h1>${title}</h1><p>${message}</p></body></html>`);
    }
    res.send(html);
  });
}

/**
 * 404 Not Found catch-all middleware for unhandled routes.
 * Should be mounted after all application routes and static assets.
 * @param {import("express").Request} req The Express request.
 * @param {import("express").Response} res The Express response.
 * @param {import("express").NextFunction} next The Express next callback.
 * @returns {void}
 */
function notFoundHandler(req, res, next) {
  const err = new Error(`Cannot ${req.method} ${req.originalUrl || req.path}`);
  err.status = 404;
  next(err);
}

module.exports = {
  errorHandler,
  notFoundHandler,
  normalizeError,
  isJsonRequest,
};
