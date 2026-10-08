// Upgrades the server-rendered home page: AJAX search/category/viewed filters and infinite scroll.
// Without JavaScript the GET form and the "Next articles" links keep working.
// The first 20 articles are already in the HTML, so page 1 is not fetched again on load.

const SCROLL_THRESHOLD_PX = 600;

const filterForm = document.getElementById("pub-filter-form");
const feedElement = document.getElementById("pub-feed");
const statusElement = document.getElementById("pub-feed-status");
const pagerElement = document.getElementById("pub-pager");
const olderLink = document.querySelector('#pub-pager [data-pager="older"]');
const newerLink = document.querySelector('#pub-pager [data-pager="newer"]');

const renderedIds = new Set();
let appliedFilters = {
  q: feedElement.dataset.q,
  category: feedElement.dataset.category,
  viewed: feedElement.dataset.viewed,
  sort: feedElement.dataset.sort,
};
let nextPage = Number(feedElement.dataset.nextPage);
let hasMore = feedElement.dataset.hasMore === "true";
let isLoading = false;
let hasFailed = false;
// Each filter change gets a new token. A response from an older token is ignored.
let requestToken = 0;

// Empty filters, viewed=all and sort=date are left out, which the server treats as the defaults.
function buildFilterParams(filters) {
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
  return params;
}

function formatDate(isoString) {
  return new Date(isoString).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

function createElement(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) {
    element.className = className;
  }
  if (text !== undefined) {
    element.textContent = text;
  }
  return element;
}

// Must produce the same markup as the card in views/public/home.ejs.
// All API text goes through textContent, never innerHTML.
function createCard(article) {
  const card = createElement("article", "pub-card");
  card.dataset.articleId = article.id;

  const link = createElement("a", "pub-card-link");
  link.href = "/articles/" + article.id;

  if (article.imageUrl) {
    const image = createElement("img", "pub-card-image");
    image.src = article.imageUrl;
    image.alt = "";
    image.loading = "lazy";
    link.appendChild(image);
  } else {
    link.appendChild(createElement("div", "pub-card-image pub-card-image-empty"));
  }

  const time = createElement("time", "", formatDate(article.publishedAt));
  time.dateTime = article.publishedAt;
  const meta = createElement("p", "pub-meta", article.authorName + " ");
  meta.appendChild(time);

  const body = createElement("div", "pub-card-body");
  body.append(
    createElement("p", "pub-category", article.category),
    createElement("h2", "pub-card-title", article.title),
    createElement("p", "pub-card-summary", article.summary),
    meta
  );

  link.appendChild(body);
  card.appendChild(link);
  return card;
}

function appendArticles(items) {
  const fragment = document.createDocumentFragment();
  for (const article of items) {
    // Skip an article that is already shown (the feed can shift if something is published meanwhile).
    if (!renderedIds.has(article.id)) {
      renderedIds.add(article.id);
      fragment.appendChild(createCard(article));
    }
  }
  feedElement.appendChild(fragment);
}

function setStatus(message, showRetry) {
  statusElement.textContent = message;
  if (showRetry) {
    const retryButton = createElement("button", "pub-retry-button", "Try again");
    retryButton.type = "button";
    retryButton.addEventListener("click", retryLoading);
    statusElement.appendChild(retryButton);
  }
}

function showResultStatus() {
  if (feedElement.children.length === 0) {
    const hasFilters = Boolean(appliedFilters.q || appliedFilters.category || appliedFilters.viewed !== "all");
    setStatus(hasFilters ? "No articles match your filters." : "No published articles yet.", false);
  } else if (!hasMore) {
    setStatus("You have reached the end of the results.", false);
  } else {
    setStatus("", false);
  }
}

async function loadNextPage() {
  if (isLoading || hasFailed || !hasMore) {
    return;
  }

  isLoading = true;
  setStatus("Loading articles...", false);
  const token = requestToken;

  try {
    const params = buildFilterParams(appliedFilters);
    params.set("page", String(nextPage));
    const response = await fetch("/api/public/articles?" + params.toString());
    if (!response.ok) {
      throw new Error("Request failed with status " + response.status);
    }
    const data = await response.json();
    if (!Array.isArray(data.items) || typeof data.hasMore !== "boolean") {
      throw new Error("Unexpected response");
    }

    // The filters changed while this request was running: the newer request owns the state now.
    if (token !== requestToken) {
      return;
    }

    appendArticles(data.items);
    // The page counter moves forward only after a successful response.
    nextPage = data.page + 1;
    hasMore = data.hasMore;
    isLoading = false;
    showResultStatus();
    loadMoreIfNeeded();
  } catch (error) {
    if (token !== requestToken) {
      return;
    }
    isLoading = false;
    hasFailed = true;
    setStatus("Could not load articles. Please check your connection.", true);
  }
}

function loadMoreIfNeeded() {
  if (isLoading || hasFailed || !hasMore) {
    return;
  }
  const distanceToBottom = document.documentElement.scrollHeight - (window.scrollY + window.innerHeight);
  if (distanceToBottom < SCROLL_THRESHOLD_PX) {
    loadNextPage();
  }
}

// An explicit click is the only way to try again after a failure, so errors cannot loop.
function retryLoading() {
  hasFailed = false;
  loadNextPage();
}

function applyFilters() {
  appliedFilters = {
    q: filterForm.elements.q.value.trim(),
    category: filterForm.elements.category.value,
    viewed: filterForm.elements.viewed.value,
    sort: filterForm.elements.sort.value,
  };

  requestToken += 1;
  isLoading = false;
  hasFailed = false;
  hasMore = true;
  nextPage = 1;
  renderedIds.clear();
  feedElement.replaceChildren();
  // Without this the old scroll position can sit near the bottom and trigger page 2 at once.
  window.scrollTo(0, 0);
  // The "Previous articles" link was built from the old filters and a page the feed no longer shows.
  if (pagerElement) {
    pagerElement.hidden = true;
  }

  // Keep the address bar in step so a reload shows the same results.
  const queryString = buildFilterParams(appliedFilters).toString();
  history.replaceState(null, "", queryString ? "/?" + queryString : "/");

  loadNextPage();
}

filterForm.addEventListener("submit", function (event) {
  event.preventDefault();
  applyFilters();
});
filterForm.elements.category.addEventListener("change", applyFilters);
filterForm.elements.viewed.addEventListener("change", applyFilters);
filterForm.elements.sort.addEventListener("change", applyFilters);
window.addEventListener("scroll", loadMoreIfNeeded, { passive: true });
window.addEventListener("resize", loadMoreIfNeeded);

for (const card of feedElement.querySelectorAll("[data-article-id]")) {
  renderedIds.add(card.dataset.articleId);
}
// Infinite scroll replaces only the "Next articles" link. "Previous articles" stays usable
// when the page was opened at ?page=2 or later.
if (olderLink) {
  olderLink.hidden = true;
}
if (pagerElement && !newerLink) {
  pagerElement.hidden = true;
}
loadMoreIfNeeded();
