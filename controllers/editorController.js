const Article = require("../models/Article");
const articleService = require("../services/articleService");
const { getSessionUser } = require("../middleware/articleAccess");
const { parseStatusFilter } = require("./articleApiController");
const {
  canEditWorkingCopy,
  canTransition,
  canDelete,
  STATUS_LABELS,
} = require("../services/articleStatus");
const { ARTICLE_STATUSES } = Article;
const { ARTICLE_CATEGORIES } = require("../models/articleCategories");
const { createHttpError } = require("../services/articleStatus");

function formatDate(value) {
  return value instanceof Date
    ? value.toLocaleString("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      }) + " UTC"
    : "—";
}

async function dashboardData(req) {
  const status = parseStatusFilter(req.query.status);
  const rawSearch = req.query.q === undefined ? "" : req.query.q;
  if (typeof rawSearch !== "string" || rawSearch.length > 100)
    throw createHttpError(
      400,
      "Search must be a single title of at most 100 characters.",
    );
  const q = rawSearch.trim();
  const rawPage = req.query.page === undefined ? "1" : req.query.page;
  if (
    typeof rawPage !== "string" ||
    !/^[1-9]\d{0,3}$/.test(rawPage) ||
    Number(rawPage) > 1000
  )
    throw createHttpError(400, "page must be between 1 and 1000.");
  const page = Number(rawPage);
  const filter = status ? { status } : {};
  if (q) {
    const search = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [{ "draft.title": search }, { "approved.title": search }];
  }
  // This route is editor/admin only. Read the fields the original design displays,
  // without changing B's list API or its response format for the reporter dashboard.
  const [articles, total] = await Promise.all([
    Article.find(filter)
      .select(
        "draft.title draft.summary approved.title approved.publishedAt authorName status createdAt updatedAt",
      )
      .sort({ updatedAt: -1, _id: -1 })
      .skip((page - 1) * 50)
      .limit(50)
      .lean(),
    Article.countDocuments(filter),
  ]);
  const pageHref = (number) => {
    const query = new URLSearchParams({ page: String(number) });
    if (status) query.set("status", status);
    if (q) query.set("q", q);
    return `/editor?${query}`;
  };
  return {
    articles,
    total,
    page,
    pages: Math.max(1, Math.ceil(total / 50)),
    q,
    activeStatus: status,
    pageHref,
    statusLabels: STATUS_LABELS,
    formatDate,
  };
}

async function renderDashboard(req, res) {
  const data = await dashboardData(req);
  res.set("Cache-Control", "private, no-store");
  res.render("editor/dashboard", {
    user: getSessionUser(req),
    ...data,
    statusTabs: ARTICLE_STATUSES.map((value) => ({
      value,
      label: STATUS_LABELS[value],
    })),
    statusLabels: STATUS_LABELS,
    formatDate,
  });
}

async function getArticles(req, res, next) {
  const data = await dashboardData(req);
  res.render("editor/cards", data, (error, html) => {
    if (error) return next(error);
    res.json({
      html,
      page: data.page,
      pages: data.pages,
      total: data.total,
      items: data.articles.map((article) => ({
        id: String(article._id),
        title: article.draft?.title || article.approved?.title || "Untitled",
        status: article.status,
      })),
    });
  });
}

function renderArticle(req, res) {
  const article = req.article;
  const user = getSessionUser(req);
  const isOwner = String(article.author) === String(user._id);
  res.set("Cache-Control", "private, no-store");
  res.render("editor/article", {
    user,
    article,
    statusLabel: STATUS_LABELS[article.status],
    categories: ARTICLE_CATEGORIES,
    canEdit: canEditWorkingCopy(article.status, user.role, isOwner),
    canApprove: canTransition(article.status, "published", user.role),
    canReturn: canTransition(article.status, "returned", user.role),
    canRemove: canDelete(article, user.role, isOwner),
    formatDate,
  });
}

async function approveArticle(req, res) {
  // approve() also records the publish event for Impact Analytics, in the same update.
  const { article } = await articleService.approve(
    req.article,
    getSessionUser(req),
  );
  res.json({ id: String(article._id), status: article.status });
}

async function returnArticle(req, res) {
  const article = await articleService.returnToReporter(
    req.article,
    getSessionUser(req),
    req.body?.note,
  );
  res.json({ id: String(article._id), status: article.status });
}

module.exports = {
  renderDashboard,
  getArticles,
  renderArticle,
  approveArticle,
  returnArticle,
};
