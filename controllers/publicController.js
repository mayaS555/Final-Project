const publicArticleService = require("../services/publicArticleService");
const articleReadService = require("../services/articleReadService");
const commentService = require("../services/commentService");

const MAX_PAGE = 1000;
const MAX_SEARCH_LENGTH = 100;
const MAX_CATEGORY_LENGTH = 50;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const VIEWED_VALUES = ["all", "viewed", "unviewed"];
const SORT_VALUES = ["date", "popular"];
const FEED_PARAMETERS = ["q", "category", "viewed", "sort", "page"];

function parsePage(rawPage) {
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

// A repeated parameter arrives as an array, so only a single string is accepted.
// An empty value (after trimming) means "no filter".
function parseOptionalText(rawValue, name, maxLength) {
  if (rawValue === undefined) {
    return { value: "" };
  }
  if (typeof rawValue !== "string") {
    return { error: `${name} must be a single text value.` };
  }
  if (CONTROL_CHARACTERS.test(rawValue)) {
    return { error: `${name} contains invalid characters.` };
  }

  const value = rawValue.trim();
  if (value.length > maxLength) {
    return { error: `${name} must be at most ${maxLength} characters.` };
  }
  return { value };
}

// Omitted or empty means "all". Anything else must be one of the allowed words.
function parseViewed(rawValue) {
  const text = parseOptionalText(rawValue, "viewed", 10);
  if (text.error) {
    return { error: text.error };
  }
  if (text.value === "") {
    return { value: "all" };
  }
  if (!VIEWED_VALUES.includes(text.value)) {
    return { error: "viewed must be all, viewed or unviewed." };
  }
  return { value: text.value };
}

// Omitted or empty means the default, newest first.
function parseSort(rawValue) {
  const text = parseOptionalText(rawValue, "sort", 10);
  if (text.error) {
    return { error: text.error };
  }
  if (text.value === "") {
    return { value: "date" };
  }
  if (!SORT_VALUES.includes(text.value)) {
    return { error: "sort must be date or popular." };
  }
  return { value: text.value };
}

// Express's default parser turns q[$ne]=x into a key named "q[$ne]" and leaves q unset,
// so a structured form of a recognized parameter has to be detected by its key.
function findStructuredParameter(query) {
  return FEED_PARAMETERS.find((name) => Object.keys(query).some((key) => key.startsWith(`${name}[`)));
}

// Shared by the HTML feed and the JSON feed so both validate and query the same way.
// Unknown parameters are ignored; only q, category, viewed, sort and page are read.
function parseFeedQuery(query) {
  const structuredName = findStructuredParameter(query);
  if (structuredName) {
    return { error: `${structuredName} must be a single value, not a structured parameter.` };
  }

  const page = parsePage(query.page);
  if (page.error) {
    return { error: page.error };
  }
  const search = parseOptionalText(query.q, "q", MAX_SEARCH_LENGTH);
  if (search.error) {
    return { error: search.error };
  }
  const category = parseOptionalText(query.category, "category", MAX_CATEGORY_LENGTH);
  if (category.error) {
    return { error: category.error };
  }
  const viewed = parseViewed(query.viewed);
  if (viewed.error) {
    return { error: viewed.error };
  }
  const sort = parseSort(query.sort);
  if (sort.error) {
    return { error: sort.error };
  }
  return { page: page.page, q: search.value, category: category.value, viewed: viewed.value, sort: sort.value };
}

// Link to a feed page that keeps the active filters (used by the no-JavaScript pager).
function buildFeedHref(filters, page) {
  const params = new URLSearchParams();
  if (filters.q) {
    params.set("q", filters.q);
  }
  if (filters.category) {
    params.set("category", filters.category);
  }
  if (filters.viewed && filters.viewed !== "all") {
    params.set("viewed", filters.viewed);
  }
  if (filters.sort && filters.sort !== "date") {
    params.set("sort", filters.sort);
  }
  if (page > 1) {
    params.set("page", String(page));
  }
  const queryString = params.toString();
  return queryString ? `/?${queryString}` : "/";
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

// Date and time for comments. UTC keeps the server-rendered text equal to the one public-comments.js builds.
function formatDateTime(isoString) {
  if (!isoString) {
    return "";
  }
  return new Date(isoString).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }) + " UTC";
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

// Shared by the HTML feed and the JSON feed. The device history is read only when it is needed,
// and a failure there is not caught: a viewed filter must not silently return the unfiltered feed.
async function loadFeed(feedQuery, deviceId) {
  const readArticleIds = feedQuery.viewed === "all" ? undefined : await articleReadService.getReadArticleIds(deviceId);
  return publicArticleService.getPublishedArticles({ ...feedQuery, readArticleIds });
}

async function renderHome(req, res) {
  const feedQuery = parseFeedQuery(req.query);
  if (feedQuery.error) {
    renderMessagePage(res, 400, "Invalid request", feedQuery.error);
    return;
  }

  const filters = { q: feedQuery.q, category: feedQuery.category, viewed: feedQuery.viewed, sort: feedQuery.sort };

  try {
    // The category list ignores the active filters, so it stays usable during a search.
    const [feed, categories] = await Promise.all([
      loadFeed(feedQuery, req.deviceId),
      publicArticleService.getPublishedCategories(),
    ]);
    // The result depends on the device cookie, so shared caches must not store it.
    res.set("Cache-Control", "private, no-cache");
    res.render("public/home", {
      pageTitle: "The Daily Web",
      feed,
      categories,
      filters,
      feedHref: (page) => buildFeedHref(filters, page),
      formatDate,
    });
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
    const feed = await loadFeed(feedQuery, req.deviceId);
    res.set("Cache-Control", "private, no-cache");
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

    // Only an article found in the public set is marked. A failure is logged and does not block the page.
    try {
      await articleReadService.markArticleRead(req.deviceId, article.id);
    } catch (error) {
      console.error("Could not store the read state:", error);
    }

    // Integration point: D's recordArticleView(article.id) belongs here, once per successful page visit.

    // The first page of comments is rendered with the article. If it cannot be read, the article is
    // still served and the page says that comments are unavailable.
    let comments = { items: [], hasMore: false, nextBefore: null };
    let commentsFailed = false;
    try {
      comments = await commentService.listComments(article.id, { viewerDeviceId: req.deviceId });
    } catch (error) {
      console.error("Could not load comments:", error);
      commentsFailed = true;
    }

    // The comment controls (edit, delete) depend on the device cookie, so shared caches must not store the page.
    res.set("Cache-Control", "private, no-cache");
    res.render("public/article", {
      pageTitle: article.title,
      article,
      paragraphs: splitParagraphs(article.content),
      comments,
      commentsFailed,
      formatDate,
      formatDateTime,
    });
  } catch (error) {
    handleUnexpectedError(error, res, false);
  }
}

module.exports = { renderHome, getFeed, renderArticle, parseFeedQuery, buildFeedHref };
