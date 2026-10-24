const Article = require("../models/Article");
const impact = require("../services/impactAnalyticsService");

function renderAnalytics(req, res) {
  res.render("editor/analytics");
}

async function getAnalytics(req, res) {
  const range = impact.parseRange(req.query);
  res.json(await impact.getImpact(req.article, range));
}

async function deleteStatistics(req, res) {
  const range = impact.parseDeleteRange(req.body);
  const { getSessionUser } = require("../middleware/articleAccess");
  res.json(await impact.deleteViewStatistics(req.article, getSessionUser(req), range));
}

module.exports = { renderAnalytics, getAnalytics, deleteStatistics };
