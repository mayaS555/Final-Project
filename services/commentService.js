// Database operations for comments, which are embedded in their article (Article.comments). Whether the parent
// article is public is checked by the caller with publicArticleService.isArticlePublished().
// Every write passes timestamps: false, so a comment never changes the article's editorial updatedAt.
// comments.deviceId is select:false, but the inclusive projections below ("comments", "comments.$") return it.

const mongoose = require("mongoose");
const Article = require("../models/Article");

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
function toPublicComment(document, articleId, viewerDeviceId) {
  const owner = isOwner(document, viewerDeviceId);
  return {
    id: String(document._id),
    articleId: String(articleId),
    displayName: document.displayName,
    body: document.body,
    createdAt: document.createdAt.toISOString(),
    updatedAt: document.updatedAt.toISOString(),
    canEdit: owner,
    canDelete: owner,
  };
}

// Newest first, with _id as the tie-breaker for equal dates. Reading continues after `cursor` instead of
// using skip, so a comment that is added or deleted between two requests cannot make the browser see a
// comment twice or miss one.
// ponytail: loads the article's whole comment array and pages in memory; use $filter/$slice if articles get thousands.
async function listComments(articleId, { cursor = null, viewerDeviceId } = {}) {
  const article = await Article.findById(articleId).select("comments").lean();
  const newestFirst = (article ? article.comments : []).sort(
    (first, second) =>
      second.createdAt - first.createdAt ||
      String(second._id).localeCompare(String(first._id)),
  );
  const remaining = cursor
    ? newestFirst.filter(
        (comment) =>
          comment.createdAt < cursor.createdAt ||
          (comment.createdAt.getTime() === cursor.createdAt.getTime() &&
            String(comment._id) < cursor.id),
      )
    : newestFirst;

  const pageDocuments = remaining.slice(0, COMMENT_PAGE_SIZE);
  return {
    items: pageDocuments.map((document) =>
      toPublicComment(document, articleId, viewerDeviceId),
    ),
    hasMore: remaining.length > COMMENT_PAGE_SIZE,
    nextBefore:
      pageDocuments.length > 0
        ? buildCursor(pageDocuments[pageDocuments.length - 1])
        : null,
  };
}

// Only the listed fields are written. The owner and the article come from the server.
async function createComment({ articleId, deviceId, displayName, body }) {
  const now = new Date();
  const comment = {
    _id: new mongoose.Types.ObjectId(),
    deviceId,
    displayName,
    body,
    createdAt: now,
    updatedAt: now,
  };
  await Article.updateOne(
    { _id: articleId },
    { $push: { comments: comment } },
    { timestamps: false, runValidators: true },
  );
  return toPublicComment(comment, articleId, deviceId);
}

// Used before an update or delete: the comment (with its owner) and its articleId, or null.
async function findCommentForChange(commentId) {
  const article = await Article.findOne({ "comments._id": commentId })
    .select({ "comments.$": 1 })
    .lean();
  return article ? { ...article.comments[0], articleId: article._id } : null;
}

// The device is part of the query, so another device's comment can never be changed here.
// Only the body can be edited. Returns null when nothing matched.
async function updateCommentBody(commentId, deviceId, body) {
  const ownComment = { comments: { $elemMatch: { _id: commentId, deviceId } } };
  const updated = await Article.findOneAndUpdate(
    ownComment,
    { $set: { "comments.$.body": body, "comments.$.updatedAt": new Date() } },
    {
      returnDocument: "after",
      timestamps: false,
      projection: { comments: { $elemMatch: { _id: commentId } } },
    },
  ).lean();
  return updated
    ? toPublicComment(updated.comments[0], updated._id, deviceId)
    : null;
}

// Returns true when a comment of this device was deleted.
async function deleteComment(commentId, deviceId) {
  const result = await Article.updateOne(
    { comments: { $elemMatch: { _id: commentId, deviceId } } },
    { $pull: { comments: { _id: commentId, deviceId } } },
    { timestamps: false },
  );
  return result.modifiedCount === 1;
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
