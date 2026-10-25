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
const { loadWeather } = require("../middleware/weatherWidget");

const router = express.Router();

// The dashboard is the reporter's own list; an admin sees every article.
router.get(
  "/reporter",
  requireReporterLogin,
  loadWeather,
  reporterController.renderDashboard,
);
// The edit page is for the article's author, an editor (while it is pending) or an admin.
router.get(
  "/reporter/articles/:id/edit",
  requireStaffLogin,
  loadArticle,
  requireArticleOwnerOrEditor,
  loadWeather,
  reporterController.renderEditPage,
);

module.exports = router;
