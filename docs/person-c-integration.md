# Person C - public site integration notes

Status: milestone 2 (title search, category filter, infinite scroll). Sorting, viewed filter,
comments and view counting are not implemented yet.

Facts below describe code that exists in this branch. Items under "Assumptions" are proposals
by C and are not agreed with A, B or D.

## Request flow

```
GET /                     -> publicController.renderHome  -+-> getPublishedArticles({ page, q, category })
GET /api/public/articles  -> publicController.getFeed     -+   (+ getPublishedCategories() for the home page)
GET /articles/:id         -> publicController.renderArticle ---> getPublishedArticleById(id)
```

The controller validates input and renders EJS or JSON. `services/publicArticleService.js` is the only file that
knows the Article field names and builds the MongoDB queries. The HTML feed and the JSON feed use the same
validation (`parseFeedQuery`) and the same service function.

## Routes and query parameters

| Route | Result |
| --- | --- |
| `GET /` | EJS feed page: filter form, first 20 matching articles, plain Newer/Older links. |
| `GET /api/public/articles` | `{ "items": [...], "page": N, "hasMore": true }`. |
| `GET /articles/:id` | EJS article page with the full content in the initial HTML. |

Both feed routes read the same parameters. Unknown parameters are ignored.

| Parameter | Rule |
| --- | --- |
| `q` | Optional. One string, at most 100 characters. Title search, see "Search". |
| `category` | Optional. One string, at most 50 characters. Exact, case-sensitive match on the approved category. |
| `page` | Optional, whole number 1 to 1000, default 1. |

`q` and `category` are trimmed. An empty value means no filter. These give HTTP 400 (`{ "error": "..." }` for the
API, an HTML message page for `/`):

- a repeated parameter (`q=a&q=b`);
- a structured form of `q`, `category` or `page` (`q[$ne]=x`, `category[a]=1`, `page[]=1`). Express's default parser
  keeps such keys as plain names like `q[$ne]`, so the controller rejects any key that starts with `q[`,
  `category[` or `page[`;
- a control character, or a value over the length limit.

Other unknown parameters, structured or not, are ignored. A valid category with no articles returns an empty result,
not an error.

Feed item fields: `id`, `title`, `summary`, `imageUrl` (or `null`), `category`, `authorName`,
`publishedAt` (ISO string). The article page also uses `content` and `updatedAt`.
An unknown, malformed, draft-only or unapproved article id gives HTTP 404.
Unexpected failures give HTTP 500 with a generic message; details are only logged on the server.

Filters are applied by MongoDB before `skip` and `limit`. Pages are 20 articles. The service fetches 21 rows to
compute `hasMore`. Ordering is `approved.publishedAt` descending, then `_id` descending (stable for equal dates).
There is no relevance or popularity sorting yet.

## Search

Search uses a MongoDB text index on `approved.title` only. It is not a substring search.
Behavior verified against MongoDB 8.0 with the dev fixture:

- Whole words only: `harbor` matches "Harbor report", `harb` matches nothing.
- Case-insensitive. English stemming: `libraries` finds "library".
- Several words match articles that contain any of them (`festival stocks`).
  A quoted phrase (`"harbor report"`) needs the whole phrase. A leading minus excludes a word (`harbor -festival`).
- Stop words (`the`, `a`) are ignored, so a query made only of stop words finds nothing.
- Summary, content, and pending or draft titles are never searched.

Language: the text index uses `default_language: "english"` because the current site and fixtures are English.
MongoDB has no Hebrew stemmer. If the final content is Hebrew, use `default_language: "none"` (whole-word match, no
stemming) and re-check these examples. This is an open decision for the team.

Performance: on the 64-document dev fixture, `explain` showed a text-search stage (TEXT_MATCH) followed by a SORT stage
for the date order. How this behaves with thousands of articles has not been measured and remains unverified.

## Categories

The category list in the filter form comes from `getPublishedCategories()`: the distinct approved categories,
sorted. It ignores the active filters, so it stays complete during a search or category filter, and it is rendered
with the home page, so there is no separate categories API. Pending or draft categories never appear in this list.

If the URL carries a category that is not in the list (`/?category=NoSuchCategory`), the form shows one extra selected
option with that exact text, escaped, so the form matches the empty result. It only echoes the request and is never
read from the database.

## Browser behavior (`public/js/public-feed.js`)

- The first 20 articles are server-rendered and page 1 is not requested again on load.
- Without JavaScript: the GET form and the Newer/Older links work and keep `q` and `category`.
- With JavaScript: submitting the form or changing the category reloads the feed through `/api/public/articles`,
  resets to page 1, scrolls to the top and updates the address bar. More pages load when the user is within
  600px of the bottom. Only the "Older articles" link is hidden, because scrolling replaces it. "Newer articles"
  stays when the page is opened at `?page=2` or later and keeps that page's filters. After a filter change the feed
  is back at page 1, so the pager is hidden to avoid a link built from the old filters.
- A new filter ignores answers to older requests, one load runs at a time, and the page counter moves only after
  a successful response. After an error the user must press "Try again"; there is no automatic retry.
- API text is inserted with `textContent`. `createCard()` mirrors the card markup in `views/public/home.ejs`;
  keep the two in sync.

## Public content rule

Public code reads only the approved version of an article. An article is public when
`approved.publishedAt` exists. `status` is not used, so an article with a pending update keeps
showing its last approved version, and a draft with no approved version is never visible.
Content is plain text: it is escaped by EJS, blank lines become paragraphs, single line breaks are kept by CSS.
Image URLs must be absolute http(s) or site-relative; anything else is dropped.

## Assumptions (not agreed)

- B's Article model can expose the approved version as `approved: { title, summary, content, category, imageUrl, authorName, publishedAt, updatedAt }`
  next to a separate `pending` revision. Field names live only in `services/publicArticleService.js`.
- Article body is plain text, not HTML.
- Feed pagination uses page/skip/limit.

## Indexes proposed for B's Article schema

Defined in `dev/devArticleModel.js` for the dev fixture, using the approved field names above:

| Index | Used by |
| --- | --- |
| `{ "approved.publishedAt": -1, _id: -1 }` | Feed without filters (confirmed with `explain`: IXSCAN). |
| `{ "approved.category": 1, "approved.publishedAt": -1, _id: -1 }` | Category filter and the category list. |
| `{ "approved.title": "text" }`, `default_language: "english"` | Title search. Required: a `$text` query fails without it. |

MongoDB allows one text index per collection. Queries with `q` use only the text index, and `category` is then applied
as a filter on its matches.

## Integration points still open

- A: mount `routes/publicRoutes.js` before `express.static` (otherwise `public/index.html` answers `GET /`),
  set the EJS view engine and the `views` folder, and call `useArticleModel(Article)` from
  `services/publicArticleService.js` once at startup with B's model. The views in `views/public/partials/` are
  temporary and should move to A's shared partials. A's central error handler can replace the try/catch in the controller.
  The home page loads `/js/public-feed.js` and `/css/public.css` from the static folder.
- B: confirm or replace the approved/pending field names above, add the three indexes, and make sure they are built
  before the first search request.
- D: `recordArticleView(articleId)` is not called yet. The call site is marked in `controllers/publicController.js`.

## Development setup (not part of the production run)

Files in `dev/` are development-only: a fixture model (`dev_public_articles` collection), a server that mounts only the
public module, a seed, and tests. The dev connection selects the database `daily_web_dev_public` regardless of the URI.
Before deleting anything, the seed checks that the model is on an open connection to that database and uses the
`dev_public_articles` collection, and throws without deleting otherwise. The seed deletes all documents in that collection.

1. Put `DEV_MONGODB_URI=<your MongoDB connection string>` in the local `.env` (see `dev/env.example`). Do not commit it.
2. `npm ci`
3. `node dev/seed-public.js` (63 approved articles, one with a different pending revision, one draft-only)
4. `node dev/public-server.js` and open http://localhost:3100. Restart it after code changes.
5. `node --test "dev/tests/*.test.js"` (`publicDb.test.js` reseeds the dev collection)

`publicNoDb.test.js` and `publicQuery.test.js` run without MongoDB. `publicDb.test.js` is skipped, and reports so,
when `DEV_MONGODB_URI` is not set.
