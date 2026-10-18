// Routes of the Article API (owned by B). Mounted by A with app.use(require("./routes/articleApiRoutes")),
// after the session middleware. Approve and return routes belong to Person D and are not here.

const express = require("express");
const articleApiController = require("../controllers/articleApiController");
const { requireStaffLogin, loadArticle, requireArticleOwnerOrEditor } = require("../middleware/articleAccess");
const { createHttpError } = require("../services/articleStatus");

const router = express.Router();

// "application/json", optionally followed by parameters such as "; charset=utf-8".
const JSON_CONTENT_TYPE = /^application\/json\s*(;|$)/i;

/**
 * Requires the application/json content type on requests that change data. A cross-site HTML form
 * cannot send it, so a form on another site cannot create, submit or change an article with the
 * reporter's session cookie (the same rule as C's comment routes).
 * @param {Object} req The Express request.
 * @param {Object} res The Express response (not used).
 * @param {Function} next Called with no argument when the type is JSON.
 * @returns {void} Passes 415 to next otherwise.
 * @example router.post("/api/articles", requireStaffLogin, requireJsonContentType, createArticle);
 */
function requireJsonContentType(req, res, next) {
  // The header is read directly: req.is() answers null for a request without a body (submit, revise).
  if (!JSON_CONTENT_TYPE.test(req.get("Content-Type") || "")) {
    next(createHttpError(415, "Send the request as application/json."));
    return;
  }
  next();
}

// Article text is up to 50000 characters; 200 KB leaves room for non-Latin text (2-3 bytes per character).
const readJsonBody = express.json({ limit: "200kb" });

// Every route checks the login first. Routes with :id then load the article and allow only its author
// or an editor; the service checks the status rules.
const writeJson = [requireJsonContentType, readJsonBody];
const ownArticle = [loadArticle, requireArticleOwnerOrEditor];

router.post("/api/articles", requireStaffLogin, writeJson, articleApiController.createArticle);
router.get("/api/articles", requireStaffLogin, articleApiController.listArticles);
router.get("/api/articles/:id", requireStaffLogin, ownArticle, articleApiController.getArticle);
router.patch("/api/articles/:id", requireStaffLogin, writeJson, ownArticle, articleApiController.saveArticle);
router.delete("/api/articles/:id", requireStaffLogin, ownArticle, articleApiController.deleteArticle);
router.post("/api/articles/:id/submit", requireStaffLogin, writeJson, ownArticle, articleApiController.submitArticle);
router.post("/api/articles/:id/revise", requireStaffLogin, writeJson, ownArticle, articleApiController.reviseArticle);

module.exports = router;
