// Single place that knows how approved article content is stored.
// Public pages and the public API read articles only through this module.
//
// Assumed storage shape (a proposal for B's Article model, not an agreement):
//   approved: { title, summary, content, category, imageUrl, authorName, publishedAt, updatedAt }
//   pending:  the draft or submitted revision, never read here
// An article is public only when approved.publishedAt exists. The status field
// is ignored on purpose: an article with a pending update must stay public.
// When B's real schema exists, only the field names in this file should change.

const FEED_PAGE_SIZE = 20;
const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

const approvedOnlyFilter = { "approved.publishedAt": { $type: "date" } };

// Deterministic order: _id breaks ties between equal publication dates.
const feedSort = { "approved.publishedAt": -1, _id: -1 };

const feedProjection = {
  "approved.title": 1,
  "approved.summary": 1,
  "approved.imageUrl": 1,
  "approved.category": 1,
  "approved.authorName": 1,
  "approved.publishedAt": 1,
};

const fullArticleProjection = {
  ...feedProjection,
  "approved.content": 1,
  "approved.updatedAt": 1,
};

let ArticleModel = null;

// Explicit hookup. A dev server or the real app passes the Mongoose model once at startup.
function useArticleModel(model) {
  ArticleModel = model;
}

function getArticleModel() {
  if (!ArticleModel) {
    throw new Error("publicArticleService has no article model. Call useArticleModel(model) at startup.");
  }
  return ArticleModel;
}

// Browsers drop tabs and newlines and treat a backslash like a slash, so "/\host" or
// "/<newline>/host" can act as "//host". Control characters and backslashes are rejected everywhere.
const UNSAFE_URL_CHARACTERS = /[\\\u0000-\u001f\u007f]/;

// Allows absolute http(s) URLs and site-relative paths. Anything else becomes null.
function toSafeImageUrl(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    return null;
  }
  if (UNSAFE_URL_CHARACTERS.test(value)) {
    return null;
  }
  if (/^\/(?!\/)/.test(value)) {
    return value;
  }
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch (error) {
    return null;
  }
}

function toIsoString(value) {
  return value instanceof Date ? value.toISOString() : null;
}

function toFeedItem(document) {
  const approved = document.approved;
  return {
    id: String(document._id),
    title: approved.title,
    summary: approved.summary || "",
    imageUrl: toSafeImageUrl(approved.imageUrl),
    category: approved.category || "General",
    authorName: approved.authorName || "",
    publishedAt: toIsoString(approved.publishedAt),
  };
}

function toFullArticle(document) {
  return {
    ...toFeedItem(document),
    content: document.approved.content || "",
    updatedAt: toIsoString(document.approved.updatedAt),
  };
}

// The filter is built field by field. q and category must already be validated strings;
// an empty string means "no filter".
// q uses MongoDB text search on the approved title only (needs a text index on that field).
function buildFeedFilter({ q, category }) {
  const filter = { ...approvedOnlyFilter };

  if (q) {
    filter.$text = { $search: q };
  }
  if (category) {
    filter["approved.category"] = category;
  }
  return filter;
}

// page must already be a validated integer >= 1.
// Filters are applied by MongoDB before skip and limit.
// One extra row is requested only to learn whether another page exists.
async function getPublishedArticles({ page, q = "", category = "" }) {
  const documents = await getArticleModel()
    .find(buildFeedFilter({ q, category }), feedProjection)
    .sort(feedSort)
    .skip((page - 1) * FEED_PAGE_SIZE)
    .limit(FEED_PAGE_SIZE + 1)
    .lean();

  return {
    items: documents.slice(0, FEED_PAGE_SIZE).map(toFeedItem),
    page,
    hasMore: documents.length > FEED_PAGE_SIZE,
  };
}

// Category choices come only from approved versions, never from pending revisions.
async function getPublishedCategories() {
  const categories = await getArticleModel().distinct("approved.category", approvedOnlyFilter);

  return categories
    .filter((category) => typeof category === "string" && category.length > 0)
    .sort((first, second) => first.localeCompare(second));
}

// Returns null for malformed ids, missing articles, and articles with no approved version.
async function getPublishedArticleById(id) {
  if (typeof id !== "string" || !OBJECT_ID_PATTERN.test(id)) {
    return null;
  }

  const document = await getArticleModel()
    .findOne({ _id: id, ...approvedOnlyFilter }, fullArticleProjection)
    .lean();

  return document ? toFullArticle(document) : null;
}

module.exports = {
  FEED_PAGE_SIZE,
  useArticleModel,
  getPublishedArticles,
  getPublishedCategories,
  getPublishedArticleById,
  toSafeImageUrl,
};
