// Reporter area pages (owned by B). The dashboard lists the logged-in reporter's articles (or every article for
// an admin) with their status and the actions allowed for each one; the edit page shows one article's working copy.
// What is shown comes from the state machine (services/articleStatus.js); the API enforces the same rules again
// when an action is used.

const articleService = require("../services/articleService");
const {
  canEditWorkingCopy,
  canTransition,
  canDelete,
  hasEditorRole,
  hasReporterRole,
} = require("../services/articleStatus");
const { parseStatusFilter } = require("./articleApiController");
const { getSessionUser } = require("../middleware/articleAccess");
const { ARTICLE_STATUSES } = require("../models/Article");
const { ARTICLE_CATEGORIES } = require("../models/articleCategories");

// Hebrew status labels shown in the badges and the filter tabs.
const STATUS_LABELS = {
  draft: "בהכנה",
  pending: "ממתינה לאישור עורך",
  published: "פורסמה",
  returned: "הוחזרה לתיקונים",
};

// Messages the dashboard shows after an action, chosen by ?msg=<key>. Only these keys are shown; the text in
// the address is never displayed, so a link cannot put its own words on the page.
const DASHBOARD_MESSAGES = {
  submitted: "Your article was sent to the editors for approval.",
  resubmitted: "Your corrected article was sent to the editors again.",
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
 * Turns one article into a dashboard row: what to show and which actions the user may use.
 * @param {Object} article A lean article from articleService.listArticles.
 * @param {Object} [user] The logged-in user; defaults to the article's reporter for the reporter dashboard.
 * @returns {Object} { id, title, category, status, statusLabel, editorNote, updatedAt, updatedAtText, isLive,
 *   hasPendingRevision, canEdit, canRevise, canDelete, editUrl, liveUrl }.
 * @example rows = articles.map((article) => toDashboardRow(article, user));
 */
function toDashboardRow(article, user = { role: "reporter" }) {
  const draft = article.draft || {};
  const approved = article.approved || {};
  const id = String(article._id);
  const isLive = approved.publishedAt instanceof Date;
  const isOwner =
    !article.author || !user._id || String(article.author) === String(user._id);
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
    canEdit: canEditWorkingCopy(article.status, user.role, isOwner),
    canRevise: isOwner && canTransition(article.status, "draft", user.role),
    canDelete: canDelete(article, user.role, isOwner),
    editUrl: editPageUrl(id),
    liveUrl: `/articles/${id}`,
  };
}

/**
 * Picks the message to show after an action.
 * @param {*} key req.query.msg.
 * @returns {string} The message for a known key, otherwise "".
 * @example dashboardMessage("submitted")
 */
function dashboardMessage(key) {
  return typeof key === "string" && Object.hasOwn(DASHBOARD_MESSAGES, key) ? DASHBOARD_MESSAGES[key] : "";
}

/**
 * GET /reporter - the reporter's dashboard, optionally filtered with ?status=, with an optional ?msg= message.
 * @param {Object} req The Express request; reads the session user, req.query.status and req.query.msg.
 * @param {Object} res The Express response.
 * @returns {Promise<void>} Renders views/reporter/dashboard.ejs. An invalid status is thrown as 400;
 *   Express 5 passes it, and database errors, to next(err).
 * @example router.get("/reporter", requireReporterLogin, renderDashboard);
 */
async function renderDashboard(req, res) {
  const status = parseStatusFilter(req.query.status);
  const user = getSessionUser(req);
  const articles = await articleService.listArticles(user, status);
  const isAdmin = user.role === "admin";
  const title = isAdmin ? "All articles" : "My articles";
  // The page shows staff data, so shared caches must not keep it.
  res.set("Cache-Control", "private, no-cache");
  res.render("reporter/dashboard", {
    pageTitle: `${title} - The Daily Web`,
    dashboardTitle: title,
    reporterName: user.name,
    rows: articles.map((article) => toDashboardRow(article, user)),
    activeStatus: status,
    statusTabs: ARTICLE_STATUSES.map((value) => ({ value, label: STATUS_LABELS[value] })),
    message: dashboardMessage(req.query.msg),
    emptyText: status
      ? "No articles with this status."
      : isAdmin
        ? "There are no articles yet."
        : "You have no articles yet. Start with \"New article\".",
  });
}

/**
 * Explains why the working copy cannot be changed right now.
 * @param {string} status The article status.
 * @param {string} role The user's role.
 * @param {boolean} isOwner true when the user wrote the article.
 * @returns {string} The message shown above a read-only form.
 * @example readOnlyReason("pending", "reporter", true)
 */
function readOnlyReason(status, role, isOwner) {
  if (hasEditorRole(role) && !isOwner) {
    return "Editors can change an article only while it is waiting for approval.";
  }
  if (status === "pending") {
    return "This article is waiting for an editor, so it cannot be changed now. You can edit it again if the editor returns it.";
  }
  if (status === "published") {
    return "This article is published. To change it, use \"Edit published article\" on the dashboard; readers keep seeing this version until an editor approves the new one.";
  }
  return "This article cannot be changed now.";
}

/**
 * Builds what the edit page shows for one article and one user.
 * @param {Object} article The article document (req.article).
 * @param {Object} user The logged-in user (the author or an editor; checked by the route).
 * @returns {Object} { id, status, statusLabel, fields (the working copy), editorNote, isLive, canEdit,
 *   readOnlyMessage, canSubmit, submitLabel, liveUrl, dashboardUrl }.
 * @example res.render("reporter/edit", { article: toEditView(req.article, user) });
 */
function toEditView(article, user) {
  const isAuthor = String(article.author) === String(user._id);
  const canEdit = canEditWorkingCopy(article.status, user.role, isAuthor);
  const draft = article.draft || {};
  const id = String(article._id);
  return {
    id,
    status: article.status,
    statusLabel: STATUS_LABELS[article.status],
    fields: {
      title: draft.title || "",
      summary: draft.summary || "",
      content: draft.content || "",
      imageUrl: draft.imageUrl || "",
      category: draft.category || "",
    },
    editorNote: article.status === "returned" ? article.editorNote : "",
    isLive: Boolean(article.approved && article.approved.publishedAt instanceof Date),
    canEdit,
    readOnlyMessage: canEdit ? "" : readOnlyReason(article.status, user.role, isAuthor),
    // Submitting is the author's action, from draft or returned.
    canSubmit: isAuthor && canTransition(article.status, "pending", user.role),
    submitLabel: article.status === "returned" ? "Resubmit" : "Submit for approval",
    liveUrl: `/articles/${id}`,
    // Reporters and admins have the dashboard; editors still have no dashboard of their own.
    dashboardUrl: hasReporterRole(user.role) ? "/reporter" : null,
  };
}

/**
 * GET /reporter/articles/:id/edit - the edit page, filled from the working copy saved on the server.
 * Shown read-only (with the reason) when the user cannot change the article in its current status.
 * @param {Object} req The Express request; reads req.article (loadArticle) and the session user.
 * @param {Object} res The Express response.
 * @returns {void} Renders views/reporter/edit.ejs.
 * @example router.get("/reporter/articles/:id/edit", requireStaffLogin, loadArticle, requireArticleOwnerOrEditor, renderEditPage);
 */
function renderEditPage(req, res) {
  // no-store: the page must always show the latest saved version, also after Back or on another computer.
  res.set("Cache-Control", "private, no-store");
  res.render("reporter/edit", {
    pageTitle: "Edit article - The Daily Web",
    article: toEditView(req.article, getSessionUser(req)),
    categories: ARTICLE_CATEGORIES,
    // The service's list, so the page highlights the same fields the server checks on submit.
    requiredFields: articleService.REQUIRED_FOR_REVIEW,
  });
}

module.exports = { renderDashboard, renderEditPage, toDashboardRow, toEditView, dashboardMessage, STATUS_LABELS };
