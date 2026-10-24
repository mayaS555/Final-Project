const express = require("express");
const controller = require("../controllers/editorController");
const analytics = require("../controllers/analyticsController");
const { getSessionUser, loadArticle } = require("../middleware/articleAccess");
const { hasEditorRole, createHttpError } = require("../services/articleStatus");

const router = express.Router();

function requireEditorLogin(req, res, next) {
  const user = getSessionUser(req);
  if (!user) return next(createHttpError(401, "Please log in."));
  if (!hasEditorRole(user.role)) return next(createHttpError(403, "Only editors and admins can use this page."));
  res.set("Cache-Control", "private, no-store");
  next();
}

// Match the JSON-only protection of B's article API, including requests with no body.
function requireJson(req, res, next) {
  if (!/^application\/json\s*(;|$)/i.test(req.get("Content-Type") || "")) {
    return next(createHttpError(415, "Send the request as application/json."));
  }
  next();
}

router.get("/editor", requireEditorLogin, controller.renderDashboard);
router.get("/editor/analytics", requireEditorLogin, analytics.renderAnalytics);
router.get("/api/editor/articles", requireEditorLogin, controller.getArticles);
router.get("/api/editor/articles/:id/impact", requireEditorLogin, loadArticle, analytics.getAnalytics);
router.get("/editor/articles/:id", requireEditorLogin, loadArticle, controller.renderArticle);
router.get("/editor.html", requireEditorLogin, (req, res) => res.redirect("/editor"));
router.get("/editor-article.html", requireEditorLogin, (req, res, next) => {
  if (typeof req.query.id !== "string" || !/^[0-9a-fA-F]{24}$/.test(req.query.id)) {
    return next(createHttpError(400, "Invalid article id."));
  }
  res.redirect(`/editor/articles/${req.query.id}`);
});

const writeArticle = [requireEditorLogin, requireJson, express.json({ limit: "200kb" }), loadArticle];
router.delete("/api/editor/articles/:id/views", writeArticle, analytics.deleteStatistics);
router.post("/api/articles/:id/approve", writeArticle, controller.approveArticle);
router.post("/api/articles/:id/return", writeArticle, controller.returnArticle);

module.exports = router;
