// Reporter area pages (owned by B). The dashboard lists the logged-in reporter's articles with their status
// and the actions allowed for each one. Which actions are shown comes from the state machine
// (services/articleStatus.js); the API enforces the same rules again when an action is used.

const articleService = require("../services/articleService");
const { canEditWorkingCopy, canTransition, canDelete } = require("../services/articleStatus");
const { parseStatusFilter } = require("./articleApiController");
const { getSessionUser } = require("../middleware/articleAccess");
const { ARTICLE_STATUSES } = require("../models/Article");

// Hebrew status labels shown in the badges and the filter tabs.
const STATUS_LABELS = {
  draft: "בהכנה",
  pending: "ממתינה לאישור עורך",
  published: "פורסמה",
  returned: "הוחזרה לתיקונים",
};

/**
 * Formats a date like C's comment dates, so the whole site shows times the same way.
 * @param {Date} date The date.
 * @returns {string} For example "Oct 18, 2026, 9:30 AM UTC", or "" without a date.
 * @example formatDateTime(article.updatedAt)
 */
function formatDateTime(date) {
  if (!(date instanceof Date)) {
    return "";
  }
  return date.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC";
}

/**
 * The address of the reporter's edit page for an article.
 * @param {string} articleId The article id.
 * @returns {string} The edit page path.
 * @example editPageUrl(row.id) // "/reporter/articles/<id>/edit"
 */
function editPageUrl(articleId) {
  return `/reporter/articles/${articleId}/edit`;
}

/**
 * Turns one article into a dashboard row: what to show and which actions the reporter may use.
 * @param {Object} article A lean article from articleService.listArticles (the reporter's own).
 * @returns {Object} { id, title, category, status, statusLabel, editorNote, updatedAt, updatedAtText, isLive,
 *   hasPendingRevision, canEdit, canRevise, canDelete, editUrl, liveUrl }.
 * @example rows = articles.map(toDashboardRow);
 */
function toDashboardRow(article) {
  const draft = article.draft || {};
  const approved = article.approved || {};
  const id = String(article._id);
  const isLive = approved.publishedAt instanceof Date;
  return {
    id,
    title: draft.title || approved.title || "Untitled",
    category: draft.category || approved.category || "",
    status: article.status,
    statusLabel: STATUS_LABELS[article.status],
    editorNote: article.editorNote,
    updatedAt: article.updatedAt instanceof Date ? article.updatedAt.toISOString() : "",
    updatedAtText: formatDateTime(article.updatedAt),
    isLive,
    // A published article that is being changed again: readers still see the approved version.
    hasPendingRevision: isLive && article.status !== "published",
    // The rows are the reporter's own articles, so isOwner is true.
    canEdit: canEditWorkingCopy(article.status, "reporter", true),
    canRevise: canTransition(article.status, "draft", "reporter"),
    canDelete: canDelete(article, "reporter", true),
    editUrl: editPageUrl(id),
    liveUrl: `/articles/${id}`,
  };
}

/**
 * GET /reporter - the reporter's dashboard, optionally filtered with ?status=.
 * @param {Object} req The Express request; reads the session user and req.query.status.
 * @param {Object} res The Express response.
 * @returns {Promise<void>} Renders views/reporter/dashboard.ejs. An invalid status is thrown as 400;
 *   Express 5 passes it, and database errors, to next(err).
 * @example router.get("/reporter", requireReporterLogin, renderDashboard);
 */
async function renderDashboard(req, res) {
  const status = parseStatusFilter(req.query.status);
  const user = getSessionUser(req);
  const articles = await articleService.listArticles(user, status);
  // The page shows the reporter's own data, so shared caches must not keep it.
  res.set("Cache-Control", "private, no-cache");
  res.render("reporter/dashboard", {
    pageTitle: "My articles - The Daily Web",
    reporterName: user.name,
    rows: articles.map(toDashboardRow),
    activeStatus: status,
    statusTabs: ARTICLE_STATUSES.map((value) => ({ value, label: STATUS_LABELS[value] })),
  });
}

module.exports = { renderDashboard, toDashboardRow, STATUS_LABELS };
