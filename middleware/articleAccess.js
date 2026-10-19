// Middleware for article routes (owned by B): loads the article named in the URL and checks who may use it.
// Used by B's Article API and reporter routes and by D's editor routes, after A's login middleware:
//   router.patch("/api/articles/:id", requireLogin, loadArticle, requireArticleOwnerOrEditor, controller)
// Errors go to next(err) with error.status, for A's error middleware.

const Article = require("../models/Article");
const { createHttpError } = require("../services/articleStatus");

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

/**
 * Returns the logged-in user from the session, or null.
 * @param {Object} req The Express request.
 * @returns {Object|null} { _id, role, name }, set by A's login. Never read from the body, query or headers.
 * @example const user = getSessionUser(req);
 */
function getSessionUser(req) {
  // TODO(B): when A's auth is merged, read the user where A stores it (req.session.user or req.user) and map it to
  // { _id, role, name }; only this function reads it.
  // Assumption until A's auth is merged: login stores the user in req.session.user. Change only this line if not.
  return req.session && req.session.user ? req.session.user : null;
}

/**
 * Builds a middleware that lets the request continue only for a logged-in user with one of the roles.
 * Stand-in until A's login and role middleware are merged; then use A's and delete this function.
 * @param {string[]} roles The allowed roles, for example ["reporter", "editor"].
 * @returns {Function} Express middleware that passes 401 (nobody logged in) or 403 (another role) to next.
 * @example const requireReporterLogin = requireLoginWithRole(["reporter"]);
 */
function requireLoginWithRole(roles) {
  return function requireRole(req, res, next) {
    const user = getSessionUser(req);
    if (!user) {
      next(createHttpError(401, "Please log in."));
      return;
    }
    if (!roles.includes(user.role)) {
      next(createHttpError(403, `Only ${roles.map((role) => `${role}s`).join(" and ")} can use this page.`));
      return;
    }
    next();
  };
}

// TODO(B): replace these two stand-ins with A's login/role middleware in routes/articleApiRoutes.js and
// routes/reporterRoutes.js, then delete requireLoginWithRole. On the reporter pages, let a 401 redirect to A's login.
// Article API: reporters and editors. Reporter area: reporters only.
const requireStaffLogin = requireLoginWithRole(["reporter", "editor"]);
const requireReporterLogin = requireLoginWithRole(["reporter"]);

/**
 * Loads the article named by :id and stores it in req.article.
 * @param {Object} req The Express request; reads req.params.id.
 * @param {Object} res The Express response (not used).
 * @param {Function} next Called with no argument on success, with an error otherwise.
 * @returns {Promise<void>} Passes 400 (not a valid id) or 404 (no such article) to next;
 *   database errors are passed to next(err) unchanged.
 * @example router.get("/api/articles/:id", requireLogin, loadArticle, requireArticleOwnerOrEditor, show);
 */
async function loadArticle(req, res, next) {
  const id = req.params.id;
  if (typeof id !== "string" || !OBJECT_ID_PATTERN.test(id)) {
    next(createHttpError(400, "Invalid article id."));
    return;
  }
  try {
    const article = await Article.findById(id);
    if (!article) {
      next(createHttpError(404, "Article not found."));
      return;
    }
    req.article = article;
    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Lets the request continue only for an editor or for the reporter who wrote req.article.
 * Must run after loadArticle. The author is compared with the session user's id, on the server.
 * @param {Object} req The Express request; reads req.article and the session user.
 * @param {Object} res The Express response (not used).
 * @param {Function} next Called with no argument when allowed.
 * @returns {void} Passes 401 (nobody logged in) or 403 (another reporter's article) to next.
 * @example router.patch("/api/articles/:id", requireLogin, loadArticle, requireArticleOwnerOrEditor, save);
 */
function requireArticleOwnerOrEditor(req, res, next) {
  const user = getSessionUser(req);
  if (!user) {
    next(createHttpError(401, "Please log in."));
    return;
  }
  const isEditor = user.role === "editor";
  const isAuthor = user.role === "reporter" && String(req.article.author) === String(user._id);
  if (!isEditor && !isAuthor) {
    next(createHttpError(403, "You can only open your own articles."));
    return;
  }
  next();
}

module.exports = { requireStaffLogin, requireReporterLogin, loadArticle, requireArticleOwnerOrEditor, getSessionUser };
