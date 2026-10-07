const publicArticleService = require("../services/publicArticleService");

const MAX_PAGE = 1000;

// Shared by the HTML feed and the JSON feed so both validate and query the same way.
function parseFeedQuery(query) {
  const rawPage = query.page;

  if (rawPage === undefined) {
    return { page: 1 };
  }
  if (typeof rawPage !== "string" || !/^[0-9]{1,4}$/.test(rawPage)) {
    return { error: `page must be a whole number from 1 to ${MAX_PAGE}.` };
  }

  const page = Number(rawPage);
  if (page < 1 || page > MAX_PAGE) {
    return { error: `page must be a whole number from 1 to ${MAX_PAGE}.` };
  }
  return { page };
}

function formatDate(isoString) {
  if (!isoString) {
    return "";
  }
  return new Date(isoString).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

// Plain-text article body: blank lines separate paragraphs, the view escapes the text.
function splitParagraphs(text) {
  return text
    .split(/\r?\n\s*\r?\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}

function renderMessagePage(res, status, title, message) {
  res.status(status).render("public/message", { pageTitle: title, title, message });
}

function handleUnexpectedError(error, res, wantsJson) {
  console.error("Public site error:", error);
  if (wantsJson) {
    res.status(500).json({ error: "Something went wrong. Please try again later." });
    return;
  }
  renderMessagePage(res, 500, "Something went wrong", "Please try again later.");
}

async function renderHome(req, res) {
  const feedQuery = parseFeedQuery(req.query);
  if (feedQuery.error) {
    renderMessagePage(res, 400, "Invalid request", feedQuery.error);
    return;
  }

  try {
    const feed = await publicArticleService.getPublishedArticles({ page: feedQuery.page });
    res.render("public/home", { pageTitle: "The Daily Web", feed, formatDate });
  } catch (error) {
    handleUnexpectedError(error, res, false);
  }
}

async function getFeed(req, res) {
  const feedQuery = parseFeedQuery(req.query);
  if (feedQuery.error) {
    res.status(400).json({ error: feedQuery.error });
    return;
  }

  try {
    const feed = await publicArticleService.getPublishedArticles({ page: feedQuery.page });
    res.json(feed);
  } catch (error) {
    handleUnexpectedError(error, res, true);
  }
}

async function renderArticle(req, res) {
  try {
    const article = await publicArticleService.getPublishedArticleById(req.params.id);
    if (!article) {
      renderMessagePage(res, 404, "Article not found", "This article does not exist or is not published.");
      return;
    }

    // Integration point: D's recordArticleView(article.id) belongs here, once per successful page visit.
    res.render("public/article", {
      pageTitle: article.title,
      article,
      paragraphs: splitParagraphs(article.content),
      formatDate,
    });
  } catch (error) {
    handleUnexpectedError(error, res, false);
  }
}

module.exports = { renderHome, getFeed, renderArticle };
