# Person C - public site integration notes

Status: milestone 3 (anonymous device cookie, read history, viewed filter). Sorting, comments and view
counting are not implemented yet.

Facts below describe code that exists in this branch. Items under "Assumptions" are proposals
by C and are not agreed with A, B or D.

## Request flow

```
GET /                     -> deviceIdentity -> renderHome   -+-> getReadArticleIds(deviceId) when viewed is not "all"
GET /api/public/articles  -> deviceIdentity -> getFeed      -+-> getPublishedArticles({ page, q, category, viewed, readArticleIds })
                                                               (+ getPublishedCategories() for the home page)
GET /articles/:id         -> deviceIdentity -> renderArticle ---> getPublishedArticleById(id), then markArticleRead(deviceId, id)
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
| `viewed` | Optional. `all` (default), `viewed` or `unviewed`. Empty means `all`. See "Viewed state". |
| `page` | Optional, whole number 1 to 1000, default 1. |

`q` and `category` are trimmed. An empty value means no filter. These give HTTP 400 (`{ "error": "..." }` for the
API, an HTML message page for `/`):

- a repeated parameter (`q=a&q=b`);
- a structured form of `q`, `category`, `viewed` or `page` (`q[$ne]=x`, `viewed[]=viewed`, `page[]=1`). Express's
  default parser keeps such keys as plain names like `q[$ne]`, so the controller rejects any key that starts with
  `q[`, `category[`, `viewed[` or `page[`;
- a `viewed` value other than the three words (case-sensitive; `not-viewed` is rejected);
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

## Viewed state

This is read history for one browser. It is not D's view statistics.

**Device cookie** (`middleware/deviceIdentity.js`, attached to the three public routes only, so static files do not get it):

| Property | Value |
| --- | --- |
| Name / value | `dw_device` / 32 lowercase hex characters from `crypto.randomBytes(16)`. |
| Lifetime | 365 days from issue. It is not renewed on later visits. |
| Attributes | `Path=/`, `HttpOnly`, `SameSite=Lax`, `Secure` when `req.secure` is true (HTTPS). Plain HTTP development still works. |

- A valid cookie is reused. A missing, malformed or wrongly formatted cookie is replaced by a new identity in the same
  response. The value is matched against a fixed pattern and never decoded, so a bad encoding cannot crash a request.
- The identity is read only from the `Cookie` header. A query string, body or other header cannot set it.
- It is anonymous browser state, not authentication: it grants no role and no permission.
- Clearing cookies creates a new identity and the old history is no longer reachable. Different browsers or profiles
  on one computer have separate histories. Private windows start empty. Nothing identifies hardware or a person.
- `req.deviceId` is available for the later comments milestone (the same middleware is reused; no comment logic yet).

**`ArticleRead`** (`models/ArticleRead.js`, collection `article_reads`, default mongoose connection):

| Field | Meaning |
| --- | --- |
| `deviceId` | The cookie value. |
| `articleId` | ObjectId of the opened article (no `ref`, B owns the Article model). |
| `readAt` | Time of the latest visit. |

Indexes: unique `{ deviceId: 1, articleId: 1 }` (also serves "all articles of this device"). No article content is copied.

- **Marking:** `GET /articles/:id` marks the article only after `getPublishedArticleById` found its approved version.
  Malformed ids, missing articles and draft-only articles give 404 and are not marked. The mark is an upsert, so
  repeated or simultaneous visits keep one record and only update `readAt`. Feed requests never mark anything, and
  there is no endpoint that takes an article id to mark. If the write fails, the error is logged and the article is
  still served.
- **Filtering:** for `viewed` or `unviewed` the controller reads the device's article ids and the service adds
  `_id: { $in: ids }` or `_id: { $nin: ids }` to the same MongoDB filter as the approved-only condition, `q` and
  `category`, before `skip` and `limit`. A new device has an empty list: nothing is viewed, everything is unviewed.
  An id of an article that is no longer public never matches, because the approved-only condition still applies.
  If reading the history fails, the request returns 500 (generic message, details in the log). It never falls back to
  the unfiltered feed.
- **Scaling tradeoff (not measured):** the id list grows with the number of articles a device has opened and is sent to
  MongoDB inside every filtered query. The approach is simple, but its performance with larger histories has not been
  measured. An alternative such as `$lookup` or a stored flag is not implemented. On the dev database `explain` showed
  the history query as a covered index scan on the unique index.
- Feed responses carry `Cache-Control: private, no-cache` because they depend on the cookie.
- **Verified:** automated tests against local MongoDB (new/reused/malformed cookie, only public articles marked,
  concurrent upserts leave one record, two devices stay independent, all/viewed/unviewed combined with `q`, `category`
  and pagination, invalid values on both routes, pending and draft content hidden, a failing write does not break the
  article page, a failing history read gives 500) and a manual pass in the embedded browser (open an article, go back,
  filter, infinite scroll, stale response ignored, retry, 390px layout). Not verified: other browsers or real phones,
  the page with JavaScript disabled in a browser (only the HTML and the links were checked), behavior behind a real
  HTTPS proxy, load or thousands of read records per device.
- **Not handled yet:** deleting an article does not delete its read records (needs coordination with B/D and an index
  on `articleId`); a record for a deleted or unpublished article is harmless but stays.

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
- Without JavaScript: the GET form and the Newer/Older links work and keep `q`, `category` and `viewed`.
- With JavaScript: submitting the form or changing the category or the viewed select reloads the feed through `/api/public/articles`,
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
- A, for the device cookie and read history (no other edit is needed):
  - nothing extra if `routes/publicRoutes.js` is mounted as described above (the middleware is attached inside the router);
  - the app must connect mongoose before the first request. The unique `{ deviceId, articleId }` index must exist
    before requests are served, because it is what keeps one record per device and article under simultaneous visits.
    When `autoIndex` is enabled (the mongoose default), `ArticleRead.init()` waits for the automatic index creation.
    When `autoIndex` is disabled, `init()` alone does not build the indexes, so A must provision the unique index
    explicitly during setup, for example with `await ArticleRead.createIndexes()`, before serving requests;
  - `req.secure` decides whether the cookie gets `Secure`. Behind an HTTPS-terminating proxy it is correct only if A
    configures Express `trust proxy` to match the real, trusted proxy topology. A value of `1` is right only for a
    deployment with exactly one trusted proxy in front of the app; otherwise `req.secure` can stay false (cookie issued
    without `Secure`) or trust headers that a client could forge. C does not set this.
- D: `recordArticleView(articleId)` is not called yet. The call site is marked in `controllers/publicController.js`.
  It must stay separate from `ArticleRead`: D's counters answer "how many views over time", C's records answer
  "did this browser open the article". They may be written in the same request, but neither reads the other.

## Development setup (not part of the production run)

Files in `dev/` are development-only: a fixture model (`dev_public_articles` collection), a server that mounts only the
public module, a seed, and tests. The dev connection selects the database `daily_web_dev_public` regardless of the URI.
Before deleting anything, the seed checks that the model is on an open connection to that database and uses the
`dev_public_articles` collection, and throws without deleting otherwise. The seed deletes all documents in that collection.

1. Put `DEV_MONGODB_URI=<your MongoDB connection string>` in the local `.env` (see `dev/env.example`). Do not commit it.
2. `npm ci`
3. `node dev/seed-public.js` (63 approved articles, one with a different pending revision, one draft-only; it also clears
   the dev read history `article_reads`, after checking that the model is on the dev database and that collection)
4. `node dev/public-server.js` and open http://localhost:3100. Restart it after code changes.
5. `node --test "dev/tests/*.test.js"` (`publicDb.test.js` reseeds the dev collection)

The tests act as devices by sending the `dw_device` cookie themselves (Node `fetch` has no cookie jar). They clear
only `article_reads` of the dev database, after the same database and collection check as the seed.

`publicNoDb.test.js` and `publicQuery.test.js` run without MongoDB. `publicDb.test.js` is skipped, and reports so,
when `DEV_MONGODB_URI` is not set.
