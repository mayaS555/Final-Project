// Article API under /api/articles (owned by B), used by the reporter area (autosave, dashboard) and
// by editors. Thin by design: parse the input, call services/articleService.js, send JSON. Every rule
// lives in the service and the state machine. Errors are thrown with error.status; Express 5 passes
// them, and any rejected promise, to next(err) for A's error middleware.
// Approve and return are NOT here: Person D's controllers call the service for those.

const articleService = require("../services/articleService");
const { ARTICLE_STATUSES } = require("../models/Article");
const { getSessionUser } = require("../middleware/articleAccess");
const { createHttpError } = require("../services/articleStatus");

/**
 * Converts dates to ISO strings and keeps null as null.
 * @param {Date|undefined|null} value A date from the article.
 * @returns {string|null} The ISO string, or null.
 * @example toIsoString(article.updatedAt) // "2026-10-18T10:00:00.000Z"
 */
function toIsoString(value) {
  return value instanceof Date ? value.toISOString() : null;
}

/**
 * Picks the content fields of the working copy or the public version.
 * @param {Object} version article.draft or article.approved.
 * @returns {Object} { title, summary, content, imageUrl, category }.
 * @example toContent(article.draft)
 */
function toContent(version) {
  return {
    title: version.title,
    summary: version.summary,
    content: version.content,
    imageUrl: version.imageUrl,
    category: version.category,
  };
}

/**
 * The full article as the API sends it to its author or an editor. Fields are listed explicitly,
 * so a field added to the model later is not sent by accident.
 * @param {Object} article An article document.
 * @returns {Object} id, status, author, working copy (draft), public version (approved or null), note, counters, dates.
 * @example res.json(toArticleResponse(req.article));
 */
function toArticleResponse(article) {
  const approved = article.approved
    ? {
        ...toContent(article.approved),
        authorName: article.approved.authorName,
        publishedAt: toIsoString(article.approved.publishedAt),
        updatedAt: toIsoString(article.approved.updatedAt),
      }
    : null;
  return {
    id: String(article._id),
    status: article.status,
    authorId: String(article.author),
    authorName: article.authorName,
    draft: toContent(article.draft),
    approved,
    editorNote: article.editorNote,
    publishCount: article.publishCount,
    createdAt: toIsoString(article.createdAt),
    updatedAt: toIsoString(article.updatedAt),
  };
}

/**
 * One row of the dashboard list.
 * @param {Object} article A lean article from articleService.listArticles.
 * @returns {Object} { id, title, publicTitle, status, editorNote, updatedAt, publishedAt }.
 * @example rows.map(toListItem)
 */
function toListItem(article) {
  return {
    id: String(article._id),
    title: article.draft ? article.draft.title : "",
    publicTitle: article.approved ? article.approved.title : null,
    status: article.status,
    editorNote: article.editorNote,
    updatedAt: toIsoString(article.updatedAt),
    publishedAt: article.approved ? toIsoString(article.approved.publishedAt) : null,
  };
}

/**
 * Reads the optional ?status= filter.
 * @param {*} rawStatus req.query.status (a string, an array when repeated, or undefined).
 * @returns {string} A valid status, or "" for no filter.
 * @throws {Error} error.status 400 for a repeated or unknown value.
 * @example const status = parseStatusFilter(req.query.status);
 */
function parseStatusFilter(rawStatus) {
  if (rawStatus === undefined || rawStatus === "") {
    return "";
  }
  if (typeof rawStatus !== "string" || !ARTICLE_STATUSES.includes(rawStatus)) {
    throw createHttpError(400, `status must be one of: ${ARTICLE_STATUSES.join(", ")}.`);
  }
  return rawStatus;
}

/**
 * POST /api/articles - creates an empty draft for the logged-in reporter.
 * @param {Object} req The Express request.
 * @param {Object} res The Express response.
 * @returns {Promise<void>} 201 with the article. 403 for an editor (thrown by the service).
 * @example router.post("/api/articles", ..., createArticle);
 */
async function createArticle(req, res) {
  const article = await articleService.createDraft(getSessionUser(req));
  res.status(201).json(toArticleResponse(article));
}

/**
 * GET /api/articles?status= - the dashboard list: a reporter's own articles, or all articles for an editor.
 * @param {Object} req The Express request; reads req.query.status.
 * @param {Object} res The Express response.
 * @returns {Promise<void>} 200 with { items }. 400 for an invalid status.
 * @example router.get("/api/articles", ..., listArticles);
 */
async function listArticles(req, res) {
  const status = parseStatusFilter(req.query.status);
  const articles = await articleService.listArticles(getSessionUser(req), status);
  res.json({ items: articles.map(toListItem) });
}

/**
 * GET /api/articles/:id - the full article, for its author or an editor.
 * @param {Object} req The Express request; reads req.article (set by loadArticle).
 * @param {Object} res The Express response.
 * @returns {void} 200 with the article.
 * @example router.get("/api/articles/:id", ..., loadArticle, requireArticleOwnerOrEditor, getArticle);
 */
function getArticle(req, res) {
  res.json(toArticleResponse(req.article));
}

/**
 * PATCH /api/articles/:id - saves the working copy (autosave target). Sends back only the save time.
 * @param {Object} req The Express request; reads req.article and the JSON body.
 * @param {Object} res The Express response.
 * @returns {Promise<void>} 200 with { savedAt }. 400 bad fields, 403 not allowed in this status, 409 changed meanwhile.
 * @example router.patch("/api/articles/:id", ..., saveArticle);
 */
async function saveArticle(req, res) {
  const article = await articleService.saveWorkingCopy(req.article, getSessionUser(req), req.body);
  res.json({ savedAt: toIsoString(article.updatedAt) });
}

/**
 * DELETE /api/articles/:id - deletes the article.
 * @param {Object} req The Express request; reads req.article.
 * @param {Object} res The Express response.
 * @returns {Promise<void>} 204. 403 when canDelete refuses, 409 changed meanwhile.
 * @example router.delete("/api/articles/:id", ..., deleteArticle);
 */
async function deleteArticle(req, res) {
  await articleService.deleteArticle(req.article, getSessionUser(req));
  res.status(204).end();
}

/**
 * POST /api/articles/:id/submit - sends the article to the editors (first submit or resubmit).
 * @param {Object} req The Express request; reads req.article.
 * @param {Object} res The Express response.
 * @returns {Promise<void>} 200 with the article. 400 incomplete, 403 not the author, 409 wrong status.
 * @example router.post("/api/articles/:id/submit", ..., submitArticle);
 */
async function submitArticle(req, res) {
  const article = await articleService.submit(req.article, getSessionUser(req));
  res.json(toArticleResponse(article));
}

/**
 * POST /api/articles/:id/revise - reopens a published article as a draft, starting from the live version.
 * @param {Object} req The Express request; reads req.article.
 * @param {Object} res The Express response.
 * @returns {Promise<void>} 200 with the article. 403 not the author, 409 not published.
 * @example router.post("/api/articles/:id/revise", ..., reviseArticle);
 */
async function reviseArticle(req, res) {
  const article = await articleService.startRevision(req.article, getSessionUser(req));
  res.json(toArticleResponse(article));
}

module.exports = {
  parseStatusFilter,
  createArticle,
  listArticles,
  getArticle,
  saveArticle,
  deleteArticle,
  submitArticle,
  reviseArticle,
};
