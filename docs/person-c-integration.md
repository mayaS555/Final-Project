# Person C - public site integration notes

Status: milestone 4 (comments with CRUD and a rate limit, on top of the device cookie, read history and viewed
filter) and milestone 5 step 1 (sort by date or popularity). View counting is not implemented by C and the
popularity input is not integrated yet (see "Sorting"). Query performance was measured once on 5000 generated articles
(see "Measurements on 5000 articles").

Facts below describe code that exists in this branch. Items under "Assumptions" are proposals
by C and are not agreed with A, B or D.

## Request flow

```
GET /                     -> deviceIdentity -> renderHome   -+-> getReadArticleIds(deviceId) when viewed is not "all"
GET /api/public/articles  -> deviceIdentity -> getFeed      -+-> getPublishedArticles({ page, q, category, viewed, sort, readArticleIds })
                                                               (+ getPublishedCategories() for the home page)
GET /articles/:id         -> deviceIdentity -> renderArticle ---> getPublishedArticleById(id), then markArticleRead(deviceId, id),
                                                               then commentService.listComments(id) for the first comments
/api/public/articles/:id/comments, /api/public/comments/:id -> commentController (see "Comments")
```

The controller validates input and renders EJS or JSON. `services/publicArticleService.js` is the only file that
knows the Article field names and builds the MongoDB queries. The HTML feed and the JSON feed use the same
validation (`parseFeedQuery`) and the same service function.

## Routes and query parameters

| Route | Result |
| --- | --- |
| `GET /` | EJS feed page: filter form, first 20 matching articles, plain Previous/Next links. |
| `GET /api/public/articles` | `{ "items": [...], "page": N, "hasMore": true }`. |
| `GET /articles/:id` | EJS article page with the full content and the first 10 comments in the initial HTML. |
| `/api/public/...comments` | Comment API, see "Comments". |

Both feed routes read the same parameters. Unknown parameters are ignored.

| Parameter | Rule |
| --- | --- |
| `q` | Optional. One string, at most 100 characters. Title search, see "Search". |
| `category` | Optional. One string, at most 50 characters. Exact, case-sensitive match on the approved category. |
| `viewed` | Optional. `all` (default), `viewed` or `unviewed`. Empty means `all`. See "Viewed state". |
| `sort` | Optional. `date` (default, newest first) or `popular`. Empty means `date`. See "Sorting". |
| `page` | Optional, whole number 1 to 1000, default 1. |

`q` and `category` are trimmed. An empty value means no filter. These give HTTP 400 (`{ "error": "..." }` for the
API, an HTML message page for `/`):

- a repeated parameter (`q=a&q=b`);
- a structured form of `q`, `category`, `viewed`, `sort` or `page` (`q[$ne]=x`, `viewed[]=viewed`, `page[]=1`). Express's
  default parser keeps such keys as plain names like `q[$ne]`, so the controller rejects any key that starts with
  `q[`, `category[`, `viewed[`, `sort[` or `page[`;
- a `viewed` value other than the three words (case-sensitive; `not-viewed` is rejected);
- a `sort` value other than `date` or `popular` (case-sensitive);
- a control character, or a value over the length limit.

Other unknown parameters, structured or not, are ignored. A valid category with no articles returns an empty result,
not an error.

Feed item fields: `id`, `title`, `summary`, `imageUrl` (or `null`), `category`, `authorName`,
`publishedAt` (ISO string). The article page also uses `content` and `updatedAt`.
An unknown, malformed, draft-only or unapproved article id gives HTTP 404.
Unexpected failures give HTTP 500 with a generic message; details are only logged on the server.

Filters and the sort are applied by MongoDB before `skip` and `limit`. Pages are 20 articles. The service fetches 21
rows to compute `hasMore`.

## Sorting

`sort=date` (default): `approved.publishedAt` descending, then `_id` descending. `sort=popular`: `totalViews`
descending, then `approved.publishedAt` descending, then `_id` descending. Both end with `_id`, so equal values never
give a random order. The sort does not change which articles match; it works together with `q`, `category` and `viewed`, in
the same database query. The HTML page, the JSON feed, the Previous/Next links and the AJAX loading all use the same
parameter and the same validation. The select in the form submits `sort`; the default `date` is left out of links.

**The popularity input C needs (proposal, not agreed with B or D).** One number per article, stored on the article itself
(not inside `approved`, because views belong to the article, not to a version): `totalViews`, a whole number of at
least 0, meaning the accumulated number of views. C only reads this field to order the feed. C does not create, change or
display it, and it does not appear in any response. Who writes it and how is for D (and B's schema) to decide; C does
not call or implement anything for it. An article without the field sorts last under `popular` (MongoDB sorts a missing
value below numbers in a descending sort), so B should give the field a default of 0.

An article that is public but has a pending update is ranked by its own popularity, and the page shows only its approved
content. A draft with no approved version is never public, whatever its views.

Popularity can change while a reader scrolls, so a later page is not a snapshot of the order the earlier pages used. An
article can then move between pages: the browser skips an id it already shows, but a different article can be missed
until the feed is reloaded. This is a limitation of the current implementation (page/skip/limit without a snapshot). The
tests use fixed data.

In the dev fixture `totalViews` is a plain number in `dev/devArticleModel.js`, set by `dev/seed-public.js` only to test
the order (it includes ties on views and date, and on views only). No index on `totalViews` is added; see
"Measurements on 5000 articles" for the reasons and the numbers.

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

## Comments

The course requirements say: a comments area with a list and a form, a new comment appears at once without reloading
the list, each guest may post at most 3 comments per minute from one device (blocked by the server, with a message), and
every model needs full CRUD. They do not define comment fields, who may edit or delete, or whether the limit must
survive a restart. Everything below about those points is C's provisional proposal, not an agreement.

**Fields** (`models/Comment.js`, collection `comments`, default mongoose connection):

| Field | Meaning |
| --- | --- |
| `articleId` | ObjectId of the article (no `ref`, B owns the Article model). |
| `deviceId` | Internal owner (the `dw_device` cookie value). `select: false`; never in a response or in HTML. |
| `displayName` | Required, trimmed, 1 to 40 characters, no control characters. Not used for authorization. |
| `body` | Required, trimmed, 1 to 1000 characters. Plain text; line breaks and tabs are kept, other control characters are rejected. |
| `createdAt`, `updatedAt` | Set by the server (mongoose `timestamps`). Never taken from the request. |

Index: `{ articleId: 1, createdAt: -1, _id: -1 }` (list of one article, newest first). Lengths are counted in
JavaScript string units, so one emoji counts as two.

**Routes** (all JSON; errors are `{ "error": "..." }`):

| Route | Result |
| --- | --- |
| `GET /api/public/articles/:id/comments?before=<cursor>` | `200 { items, hasMore, nextBefore }`. At most 10 items, newest first. |
| `POST /api/public/articles/:id/comments` body `{ displayName, body }` | `201` with the created comment. |
| `PATCH /api/public/comments/:id` body `{ body }` | `200` with the updated comment. Only the text can be edited. |
| `DELETE /api/public/comments/:id` | `204`. |

There is no `GET /api/public/comments/:id`: the list is the Read operation.

A comment in a response has exactly: `id`, `articleId`, `displayName`, `body`, `createdAt`, `updatedAt` (ISO strings),
`canEdit`, `canDelete`. The last two are `true` only for the device that wrote the comment; the server checks ownership
again on every change. Because they depend on the cookie, the list response and the article page are sent with
`Cache-Control: private, no-cache`.

Status codes: `400` invalid input (malformed JSON, a body that is not a JSON object, a bad field, or a bad `before`), `415` a POST or
PATCH whose `Content-Type` is not `application/json`, `403` the
comment belongs to another device, `404` malformed id, missing comment, or an article without an approved public version
(the same answer for a draft-only article, so nothing is revealed), `413` body over 10 KB, `429` rate limit,
`500` generic message with details only in the server log.

**Ownership policy (provisional):** anyone can read comments of public articles. A device can create comments and edit or
delete only its own. The check uses `req.deviceId` from the cookie. The cookie is anonymous browser identity, not a
verified person: clearing it means the comments can no longer be edited from that browser, and nobody can claim them
back. Only `body` is written on update. `displayName`, `articleId`, `deviceId`, dates, `role` and any other field in a
request body, query string or header are ignored. Editor rights are not granted: they need A's real server-side roles
(see open points). No fake role exists.

**Comment operations require a public article.** Listing, creating, editing and deleting first check that the article
has an approved version (`publicArticleService.isArticlePublished`). Comments that already exist on an article that is
draft-only or missing cannot be read, edited or deleted through the API, even by their author.

**Reading and order:** newest first by `createdAt`, then `_id`. `nextBefore` is `<createdAt in ms>_<comment id>` of the
last item; the next request sends it as `before` and receives only older comments. This is used instead of page/skip
because comments are added and deleted while a reader is on the page: with skip a deletion would skip a comment and an
addition would repeat one. `before` is validated (repeated or structured forms give 400).

**Rate limit** (`services/commentRateLimiter.js`): at most 3 successful new comments per device in any rolling 60
seconds, counted across all articles. Order in `createComment`: validate the body, check that the article is public,
then `reserve(deviceId)`, then write to MongoDB. The check and the reservation are one synchronous step, so simultaneous
requests cannot all pass. A failed write calls `release()` for that exact reservation. Invalid input and nonpublic
articles never reach `reserve`, and editing or deleting never uses or returns a slot. Over the limit the answer is `429`
with `Retry-After: <seconds>` and `{ error, retryAfterSeconds }`. Expired timestamps of a device are dropped when that device
posts again. Entries of other devices are swept lazily: `reserve()` removes devices without live entries, at most once per
window. An expired entry can therefore stay in the map until a later sweep; the map is not guaranteed to hold only the
devices active in the last minute.

Limitations: the counters are in memory, so they reset when the server restarts; each server process has its own
counters, so several processes allow 3 per process; and a person can get a fresh quota by clearing the cookie or using
another browser. The requirements do not say the limit must survive a restart or work across servers, so this was chosen
for a single-process course application. If persistence or several processes are needed, the limiter must become an
atomic shared counter in MongoDB (a count followed by an insert is not enough).

**Cross-site requests:** no CSRF token. POST and PATCH are rejected with 415 unless `Content-Type` is `application/json`
(a charset parameter is accepted). This is an explicit check in `routes/commentRoutes.js`, run before the JSON parser and the
controller, so a rejected request never reaches the rate limiter or the database. It does not rely on `req.body` being empty:
the shared server mounts `express.urlencoded()` before the routes, which fills `req.body` from a plain HTML form. DELETE has
no body. No CORS headers are sent, so another site cannot send a JSON write from a browser, and the cookie is
`SameSite=Lax`. A project-wide CSRF mechanism, if A adds one, should be applied to these routes too.

**Browser behavior** (`public/js/public-comments.js`): the first 10 comments are rendered by EJS. Posting sends JSON,
and the server's returned record is added to the top of the list without fetching the list again; the text box is
cleared only after success, the name is kept. While a request runs the button is disabled and a second submit does
nothing. Validation, 403/404, rate-limit and network errors are shown next to the form or the comment, and typed text
stays. Edit replaces the text with a box inside the item and changes only that item; Delete asks `window.confirm`
and removes only that item. "Load more comments" reads the next 10 with `before`, skips ids already shown, and a failure
leaves the button so pressing it again is the retry. All API text uses `textContent`; EJS escapes the rest. Without
JavaScript the comments are visible but posting, editing and deleting are not possible: the form controls are inside a
`<fieldset disabled>` in the HTML and `public-comments.js` enables them only after its submit handler is attached, so the
form can never be sent as a native GET with the comment text in the URL. There is no non-JavaScript posting route; a
`<noscript>` note explains this. `createCommentItem()` mirrors the
comment markup in `views/public/article.ejs`; keep the two in sync.

**Verified:** automated tests (209 passed against local MongoDB 8.0; the database tests are skipped without
`DEV_MONGODB_URI`): form POST and PATCH behind `express.urlencoded()` rejected with 415 before any reservation or write,
charset accepted, the form served disabled, CRUD and validation, a second device rejected (403) for edit and delete, forged owner,
article, date and role fields in the body, query and headers, draft-only and missing articles, hostile text escaped in the
page, stable pagination with ties and with changes between two pages, first three allowed and fourth rejected, one shared
quota across articles, independent devices, 12 simultaneous requests giving exactly 3 successes, invalid input,
nonpublic articles and failed writes not using a slot, edits and deletes not using or returning a slot. The rolling
window and the cleanup are tested with a fake clock only (`commentNoDb.test.js`), not by waiting a minute over HTTP.
Manual pass in the embedded browser: post, hostile text shown as text, edit, delete, blank-comment error with the text
kept, double submit sending one request, network failure, the 429 message, Load more (17 comments, no duplicates),
a 390px layout without horizontal scroll. With the comment script blocked in the browser, the controls were disabled and
could not be clicked or typed into. Not verified: another device in a real second browser (covered by tests that
send a different cookie), other browsers or phones, a browser with JavaScript fully switched off (the script was blocked
instead), behavior behind a proxy, restart or multi-process behavior of the limiter, load.

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

Performance: with a text query the plan is a text-index scan followed by an in-memory SORT. Numbers for 5000 articles are
in "Measurements on 5000 articles".

## Categories

The category list in the filter form comes from `getPublishedCategories()`: the distinct approved categories,
sorted. It ignores the active filters, so it stays complete during a search or category filter, and it is rendered
with the home page, so there is no separate categories API. Pending or draft categories never appear in this list.

If the URL carries a category that is not in the list (`/?category=NoSuchCategory`), the form shows one extra selected
option with that exact text, escaped, so the form matches the empty result. It only echoes the request and is never
read from the database.

## Browser behavior (`public/js/public-feed.js`)

- The first 20 articles are server-rendered and page 1 is not requested again on load.
- Without JavaScript: the GET form and the Previous/Next links work and keep `q`, `category`, `viewed` and `sort`.
- With JavaScript: submitting the form or changing the category, viewed or sort select reloads the feed through `/api/public/articles`,
  resets to page 1, scrolls to the top and updates the address bar. More pages load when the user is within
  600px of the bottom. Only the "Next articles" link is hidden, because scrolling replaces it. "Previous articles"
  stays when the page is opened at `?page=2` or later and keeps that page's filters. After a filter change the feed
  is back at page 1, so the pager is hidden to avoid a link built from the old filters.
- A new filter ignores answers to older requests, one load runs at a time, and the page counter moves only after
  a successful response. After an error the user must press "Try again"; there is no automatic retry.
- API text is inserted with `textContent`. `createCard()` mirrors the card markup in `views/public/home.ejs`;
  keep the two in sync.

## Measurements on 5000 articles

`node dev/measure-feed-queries.js` (needs `DEV_MONGODB_URI`) builds 5000 generated articles in the separate collection
`dev_public_articles_bench` of the dev database, runs the feed queries through the real `getPublishedArticles()`, asks
MongoDB to `explain("executionStats")` the same query, and drops the collection at the end. Before it deletes or inserts
anything it checks the connection, the database name and the collection name (`assertBenchTarget`, covered by
`publicNoDb.test.js`). It first drops the bench collection with its indexes, so nothing from an earlier run (for example
a candidate index) can remain, and it builds the indexes of the dev model again. It sets `autoIndex` and `autoCreate` to
false before loading the dev article model, so loading the model creates nothing. It never reads or writes
`dev_public_articles`, `article_reads` or `comments`. With `--candidate-indexes` it also creates two popularity indexes
in the bench collection only, to show what they would change. The script stops with an error if a page that must contain
articles is empty.

Setup of the run documented here: MongoDB 8.0.32 and Node 24.21.0 on one development Mac, one client, warm cache, 3 warm-up
and 15 timed runs per query. Data (fixed random seed; dates are relative to the time of the run): 5000 documents, 4749
public, 490 of them with a pending revision, 251 draft only; 8 categories (uneven); 20 percent of the view counts are 0 and
many values repeat. About 30 percent of the articles get a publication date without a time-of-day offset (a whole number of
days before the run), so those can share the exact same date; the other dates are almost never equal. Existing indexes of
the dev model: date, category + date, approved title text. Numbers are the median of the service call in milliseconds; keys
and docs are `totalKeysExamined` and `totalDocsExamined` from explain. "Read ids" are lists built in memory.

| Query (page 1 unless noted) | date | popular | popular with candidate indexes |
| --- | --- | --- | --- |
| no filter | 0.4 ms, 21 keys, 21 docs | 2.7 ms, 4749 keys, 4749 docs, in-memory sort | 0.3 ms, 22 keys, 22 docs |
| no filter, page 200 (deep, 20 articles) | 0.9 ms, 4001 keys, 21 docs | 4.4 ms, 4749 keys, 4749 docs, sort | 2.1 ms, 4201 keys, 4201 docs |
| no filter, page 250 (past the end, 0 articles) | 0.9 ms, 4749 keys, 0 docs | 4.1 ms, 4749 keys, 4749 docs, sort | 2.2 ms, 5000 keys, 5000 docs |
| category Technology (largest) | 0.3 ms, 21 keys, 21 docs | 0.9 ms, 1162 keys, 1162 docs, sort | 0.3 ms, 21 keys, 21 docs |
| category Health (smallest) | 0.3 ms, 21 keys, 21 docs | 0.5 ms, 413 keys, 413 docs, sort | 0.3 ms, 21 keys, 21 docs |
| search `market` | 0.6 ms, 385 keys, 770 docs, sort | 0.6 ms, same plan | 0.6 ms, same plan |
| search `Reykjavik` | 0.4 ms, 164 keys, 328 docs, sort | 0.4 ms, same plan | 0.4 ms, same plan |
| search `market` + category Markets | 0.5 ms, 385 keys, 770 docs, sort | 0.5 ms, same plan | 0.5 ms, same plan |
| unviewed, 1000 read ids | 0.7 ms, 22 keys, 21 docs | 3.7 ms, 4750 keys, 3749 docs, sort | 0.4 ms, 31 keys, 31 docs |
| unviewed, 4000 read ids | 2.2 ms, 145 keys, 21 docs | 4.7 ms, 4750 keys, 749 docs, sort | 1.2 ms, 142 keys, 142 docs |
| viewed, 1000 read ids | 0.6 ms, 107 keys, 21 docs | 1.4 ms, 1791 keys, 1000 docs, sort | 0.5 ms, 72 keys, 72 docs |
| category Technology + unviewed, 1000 | 0.6 ms, 28 keys, 21 docs | 1.4 ms, 1163 keys, 924 docs, sort | 0.6 ms, 27 keys, 21 docs |
| search + category + unviewed, 1000 | 0.8 ms, 385 keys, 770 docs, sort | 0.8 ms, same plan | 0.8 ms, same plan |

`getPublishedCategories()` (distinct): 2.1 ms median. The largest single timed run in the baseline table was 5.0 ms.
Every page marked 20 articles returned 20; page 250 is past the end of the 4749 public articles and returns none, which
shows only that a request beyond the end is cheap for `date` and not for `popular`.

Findings:

- **date:** every query without text search stops after about 21 documents using the existing indexes (0.3 to 2.2 ms);
  unviewed with 4000 read ids scans 145 keys. A deep page (200) skips 3980 index keys and fetches 21 documents. No new index
  is needed for `date` at this size.
- **popular without an index:** MongoDB reads every matching article and sorts in memory, so the work grows with the number
  of matching articles (413 to 4750 documents here, 0.5 to 4.7 ms). What happens above 5000 articles is not measured.
- **search:** the text index drives the plan and the results are sorted in memory, for date and for popular alike, so the
  sort option changes nothing for text queries (164 to 385 matching keys).
- **candidate indexes** `{ totalViews: -1, "approved.publishedAt": -1, _id: -1 }` and `{ "approved.category": 1, totalViews: -1,
  "approved.publishedAt": -1, _id: -1 }` reduced the work of the measured popular queries without text search
  considerably: 21 to 142 keys instead of 413 to 4750, and the time fell from 0.5 to 4.7 ms to 0.3 to 1.2 ms. They do not
  change text queries, and the deep pages (200, 250) still read thousands of keys and documents.
- **Decision (temporary):** the candidate indexes are not added to the dev model for now. This depends on integration: it
  needs B's real data size and the way D maintains `totalViews`. An index on `totalViews` means the database also updates
  that article's index entries whenever the value changes. The cost of that was not measured, because C does not implement
  the counter, so this note makes no claim about how large it is. If popular queries are slow with the real data, the
  single index on `totalViews` is the first one to try; the category variant is optional. B and D decide together with C.

Limits of these numbers: one machine, one client, no concurrent requests, synthetic data, warm cache, localhost network.
Read-id lists are made in memory, so they do not measure the `ArticleRead` lookup of the real history
(`getReadArticleIds`), only what the feed query does with a list of that size. They say nothing about behavior with many
simultaneous users and are not a load test.

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
- Popularity means accumulated views of the article, available as a number `totalViews` on the article document. The
  PDF only says "popularity" and does not define it.

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
  before the first search request. For `sort=popular`: decide whether the article document has a numeric `totalViews`
  (default 0) and tell C if the name or place differs. Any index for it will be proposed after measuring.
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
- A, for comments: mounting `routes/publicRoutes.js` is enough, it includes `routes/commentRoutes.js`. The JSON parser
  is attached only to the two routes that read a body (`express.json({ limit: "10kb" })`), and a router-level error
  handler turns malformed or oversized JSON into JSON 400/413. `Comment.init()` (or `createIndexes()` when `autoIndex`
  is off) should run at startup like the other models. Do not put a global body parser or a global error page in front of
  these routes that would answer in HTML. Open decisions: whether editors may edit or delete any comment (needs A's
  session and roles; until then no editor rights exist), and whether the project wants a CSRF mechanism.
- D, for the comments seed: D owns the final demo comments. C's seed adds no comment fixtures and only clears the dev
  `comments` collection. Seeded documents must have `articleId` (ObjectId of an article with an approved version),
  `displayName` (1 to 40 characters), `body` (1 to 1000 characters), `createdAt` and `updatedAt`, and a `deviceId` that is
  any 32-character lowercase hex string (use random ones, not a real reader's cookie). Insert with `timestamps: false`
  (or raw) if `createdAt` is back-dated, otherwise mongoose sets it. Display order follows `createdAt`, then `_id`.
  Comments of deleted or draft-only articles are never shown. When an article is deleted its comments and `ArticleRead`
  records should be deleted too; that needs coordination with B and D and is not done.
- D: C needs only that a number such as `totalViews` is available on the article document (see "Sorting"). How it is
  maintained is D's decision. If D keeps the counts elsewhere (for example per hour in a separate collection), tell C,
  because sorting by a value from another collection would need a different query.
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
   the dev read history `article_reads` and the dev `comments`, after checking for each model that it is on the dev
   database and uses that collection)
4. `node dev/public-server.js` and open http://localhost:3100. Restart it after code changes.
5. `node --test "dev/tests/*.test.js"` (`publicDb.test.js` reseeds the dev collection)
6. Optional: `node dev/measure-feed-queries.js` (see "Measurements on 5000 articles"; it uses only its own bench collection)

The tests act as devices by sending the `dw_device` cookie themselves (Node `fetch` has no cookie jar). They clear
only `article_reads` and `comments` of the dev database, after the same database and collection check as the seed.
The comment database tests are inside `publicDb.test.js` (not a separate file) because every file that reseeds the
article collection would collide with the others, since `node --test` runs files in parallel.

`publicNoDb.test.js`, `commentNoDb.test.js` and `publicQuery.test.js` run without MongoDB. `publicDb.test.js` is skipped, and reports so,
when `DEV_MONGODB_URI` is not set.
