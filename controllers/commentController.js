// Comment API under /api/public. Provisional ownership policy (not defined by the course
// requirements): anyone can read comments on public articles, a device can create comments and
// edit or delete only its own. Ownership is decided on the server from req.deviceId (the anonymous
// cookie set by deviceIdentity). Nothing about the owner, the article or a role is taken from the body.

const commentService = require("../services/commentService");
const { isArticlePublished } = require("../services/publicArticleService");
const { commentRateLimiter } = require("../services/commentRateLimiter");

const MAX_NAME_LENGTH = 40;
const MAX_BODY_LENGTH = 1000;
const NAME_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
// Tab, newline and carriage return are allowed in a comment body.
const BODY_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function sendError(res, status, message) {
  res.status(status).json({ error: message });
}

function sendNotFound(res) {
  sendError(res, 404, "Comment or article not found.");
}

function handleUnexpectedError(error, res) {
  console.error("Comment API error:", error);
  sendError(res, 500, "Something went wrong. Please try again later.");
}

function parseDisplayName(value) {
  if (typeof value !== "string") {
    return { error: "displayName must be text." };
  }
  const displayName = value.trim();
  if (displayName.length === 0) {
    return { error: "Please enter your name." };
  }
  if (displayName.length > MAX_NAME_LENGTH) {
    return { error: `The name must be at most ${MAX_NAME_LENGTH} characters.` };
  }
  if (NAME_CONTROL_CHARACTERS.test(displayName)) {
    return { error: "The name contains invalid characters." };
  }
  return { value: displayName };
}

function parseCommentBody(value) {
  if (typeof value !== "string") {
    return { error: "body must be text." };
  }
  const body = value.replace(/\r\n/g, "\n").trim();
  if (body.length === 0) {
    return { error: "Please write a comment." };
  }
  if (body.length > MAX_BODY_LENGTH) {
    return { error: `The comment must be at most ${MAX_BODY_LENGTH} characters.` };
  }
  if (BODY_CONTROL_CHARACTERS.test(body)) {
    return { error: "The comment contains invalid characters." };
  }
  return { value: body };
}

// The route has already required the application/json content type; this only checks the parsed shape.
// Only the fields read below are used; any other field in the body is ignored.
function readJsonObject(req) {
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  return body;
}

// The cursor is optional. A repeated or structured "before" is rejected like in the feed.
function parseBeforeParameter(query) {
  if (Object.keys(query).some((key) => key.startsWith("before["))) {
    return { error: "before must be a single value, not a structured parameter." };
  }
  if (query.before === undefined || query.before === "") {
    return { cursor: null };
  }
  const cursor = commentService.parseCursor(query.before);
  return cursor ? { cursor } : { error: "before is not a valid cursor." };
}

async function listComments(req, res) {
  const before = parseBeforeParameter(req.query);
  if (before.error) {
    sendError(res, 400, before.error);
    return;
  }

  try {
    if (!(await isArticlePublished(req.params.id))) {
      sendNotFound(res);
      return;
    }
    const result = await commentService.listComments(req.params.id, {
      cursor: before.cursor,
      viewerDeviceId: req.deviceId,
    });
    // canEdit and canDelete depend on the device cookie.
    res.set("Cache-Control", "private, no-cache");
    res.json(result);
  } catch (error) {
    handleUnexpectedError(error, res);
  }
}

async function createComment(req, res) {
  // Validate first: an invalid submission must not use a rate-limit slot.
  const input = readJsonObject(req);
  if (!input) {
    sendError(res, 400, "The request body must be a JSON object.");
    return;
  }
  const displayName = parseDisplayName(input.displayName);
  if (displayName.error) {
    sendError(res, 400, displayName.error);
    return;
  }
  const body = parseCommentBody(input.body);
  if (body.error) {
    sendError(res, 400, body.error);
    return;
  }

  try {
    if (!(await isArticlePublished(req.params.id))) {
      sendNotFound(res);
      return;
    }

    // The check and the reservation are one synchronous step, before the database write is awaited.
    const slot = commentRateLimiter.reserve(req.deviceId);
    if (!slot.allowed) {
      res.set("Retry-After", String(slot.retryAfterSeconds));
      res.status(429).json({
        error: `You can post at most ${commentRateLimiter.limit} comments per minute. Please try again in ${slot.retryAfterSeconds} seconds.`,
        retryAfterSeconds: slot.retryAfterSeconds,
      });
      return;
    }

    let comment;
    try {
      comment = await commentService.createComment({
        articleId: req.params.id,
        deviceId: req.deviceId,
        displayName: displayName.value,
        body: body.value,
      });
    } catch (error) {
      // A failed write must not use up the slot.
      slot.release();
      throw error;
    }
    res.status(201).json(comment);
  } catch (error) {
    handleUnexpectedError(error, res);
  }
}

// Shared by update and delete: finds the comment, then checks that its article is still public
// and that this device owns it. Sends the error response and returns null when a check fails.
async function loadOwnComment(req, res) {
  if (!commentService.isValidObjectId(req.params.id)) {
    sendNotFound(res);
    return null;
  }
  const comment = await commentService.findCommentForChange(req.params.id);
  if (!comment || !(await isArticlePublished(String(comment.articleId)))) {
    sendNotFound(res);
    return null;
  }
  if (!commentService.isOwner(comment, req.deviceId)) {
    sendError(res, 403, "You can only change your own comments.");
    return null;
  }
  return comment;
}

async function updateComment(req, res) {
  const input = readJsonObject(req);
  if (!input) {
    sendError(res, 400, "The request body must be a JSON object.");
    return;
  }
  const body = parseCommentBody(input.body);
  if (body.error) {
    sendError(res, 400, body.error);
    return;
  }

  try {
    const comment = await loadOwnComment(req, res);
    if (!comment) {
      return;
    }
    // The ownership check is repeated inside the update query.
    const updated = await commentService.updateCommentBody(req.params.id, req.deviceId, body.value);
    if (!updated) {
      sendNotFound(res);
      return;
    }
    res.json(updated);
  } catch (error) {
    handleUnexpectedError(error, res);
  }
}

async function deleteComment(req, res) {
  try {
    const comment = await loadOwnComment(req, res);
    if (!comment) {
      return;
    }
    const deleted = await commentService.deleteComment(req.params.id, req.deviceId);
    if (!deleted) {
      sendNotFound(res);
      return;
    }
    res.status(204).end();
  } catch (error) {
    handleUnexpectedError(error, res);
  }
}

module.exports = {
  listComments,
  createComment,
  updateComment,
  deleteComment,
  parseDisplayName,
  parseCommentBody,
  MAX_NAME_LENGTH,
  MAX_BODY_LENGTH,
};
