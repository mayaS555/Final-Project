// Pages of the reporter area (owned by B). Mounted by A with app.use(require("./routes/reporterRoutes")),
// after the session middleware. Every check is on the server.

const express = require("express");
const reporterController = require("../controllers/reporterController");
const {
  requireReporterLogin,
  requireStaffLogin,
  loadArticle,
  requireArticleOwnerOrEditor,
} = require("../middleware/articleAccess");

const router = express.Router();

// The dashboard is the reporter's own list.
router.get("/reporter", requireReporterLogin, reporterController.renderDashboard);
// The edit page is for the article's author, or an editor (who may change it while it is pending).
router.get(
  "/reporter/articles/:id/edit",
  requireStaffLogin,
  loadArticle,
  requireArticleOwnerOrEditor,
  reporterController.renderEditPage
);

module.exports = router;
