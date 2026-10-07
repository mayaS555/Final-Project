// Database operations for comments. Whether the parent article is public is checked by the
// caller with publicArticleService.isArticlePublished().

const Comment = require("../models/Comment");

const COMMENT_PAGE_SIZE = 10;
const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;
// "<createdAt in milliseconds>_<comment id>": position of the last comment the browser already has.
const CURSOR_PATTERN = /^([0-9]{1,15})_([0-9a-f]{24})$/;

function isValidObjectId(value) {
  return typeof value === "string" && OBJECT_ID_PATTERN.test(value);
}

// Returns { createdAt, id } or null for text that is not a cursor.
function parseCursor(text) {
  const match = typeof text === "string" ? CURSOR_PATTERN.exec(text) : null;
  return match ? { createdAt: new Date(Number(match[1])), id: match[2] } : null;
}

function buildCursor(document) {
  return `${document.createdAt.getTime()}_${document._id}`;
}

// The ownership rule lives here. Provisional policy: only the device that wrote a comment may
// change it. Editor rights are not granted until A's server-side roles exist.
function isOwner(document, deviceId) {
  return typeof deviceId === "string" && document.deviceId === deviceId;
}

// Explicit public fields. deviceId is never copied into the result.
function toPublicComment(document, viewerDeviceId) {
  const owner = isOwner(document, viewerDeviceId);
  return {
    id: String(document._id),
    articleId: String(document.articleId),
    displayName: document.displayName,
    body: document.body,
    createdAt: document.createdAt.toISOString(),
    updatedAt: document.updatedAt.toISOString(),
    canEdit: owner,
    canDelete: owner,
  };
}

// Newest first. Reading continues after `cursor` instead of using skip, so a comment that is
// added or deleted between two requests cannot make the browser see a comment twice or miss one.
async function listComments(articleId, { cursor = null, viewerDeviceId } = {}) {
  const filter = { articleId };
  if (cursor) {
    filter.$or = [
      { createdAt: { $lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, _id: { $lt: cursor.id } },
    ];
  }

  // One extra row only tells whether another page exists.
  const documents = await Comment.find(filter)
    .select("+deviceId")
    .sort({ createdAt: -1, _id: -1 })
    .limit(COMMENT_PAGE_SIZE + 1)
    .lean();

  const pageDocuments = documents.slice(0, COMMENT_PAGE_SIZE);
  return {
    items: pageDocuments.map((document) => toPublicComment(document, viewerDeviceId)),
    hasMore: documents.length > COMMENT_PAGE_SIZE,
    nextBefore: pageDocuments.length > 0 ? buildCursor(pageDocuments[pageDocuments.length - 1]) : null,
  };
}

// Only the listed fields are written. The owner and the article come from the server.
async function createComment({ articleId, deviceId, displayName, body }) {
  const created = await Comment.create({ articleId, deviceId, displayName, body });
  return toPublicComment(created.toObject(), deviceId);
}

// Used before an update or delete: who owns the comment and which article it belongs to.
async function findCommentForChange(commentId) {
  return Comment.findById(commentId).select("+deviceId").lean();
}

// The device is part of the query, so another device's comment can never be changed here.
// Only the body can be edited. Returns null when nothing matched.
async function updateCommentBody(commentId, deviceId, body) {
  const updated = await Comment.findOneAndUpdate(
    { _id: commentId, deviceId },
    { $set: { body } },
    { returnDocument: "after" }
  )
    .select("+deviceId")
    .lean();
  return updated ? toPublicComment(updated, deviceId) : null;
}

// Returns true when a comment of this device was deleted.
async function deleteComment(commentId, deviceId) {
  const result = await Comment.deleteOne({ _id: commentId, deviceId });
  return result.deletedCount === 1;
}

module.exports = {
  COMMENT_PAGE_SIZE,
  isValidObjectId,
  parseCursor,
  isOwner,
  listComments,
  createComment,
  findCommentForChange,
  updateCommentBody,
  deleteComment,
};
