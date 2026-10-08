# Person C - public site handoff

## Summary

**What C implemented** (in this branch, under `controllers/`, `services/`, `middleware/`, `models/`, `routes/`,
`views/public/`, `public/js/public-*.js`, `public/css/public.css`):

- Public home page and article page, server-rendered with EJS (the full article text is in the initial HTML).
- Public feed API with title search, category filter, viewed/unviewed filter, sort by date or popularity, 20 per page.
- Infinite scroll and AJAX filtering in the browser, with plain Previous/Next links when JavaScript is off.
- Per-device read state (an anonymous cookie plus an `ArticleRead` collection).
- Comment model with create, read, update and delete over AJAX, and a limit of 3 new comments per device per minute.

**Status: a module ready for integration, not a standalone application.** It has not been connected to the shared
server. The branch adds files only. It does not mount C in `server.js`, does not change `package.json`, and does not
change what `npm start` does. There is no demo server, no fixture model and no seed in this branch: C's pages and API
start working only after A mounts the router and the article model is passed in (section 3). The branch also contains
no automated tests of C (see section 5).

**Connections needed from the team** (details in section 3): A mounts the router before the global body parsers and
`express.static`, sets up EJS with the project's `views` folder as the template root, connects mongoose and passes B's
Article model to C; B confirms the approved-version field names and adds the indexes; D provides the view counter and
the call to record a view. None of these exist in `main` today.

**How to read this document.** Section 1 describes behavior that exists in this branch ("Implemented"). Sections 2 and
3 list what C proposes or needs from others; these are proposals, not agreements. Section 4 lists open questions; they
are not new requirements for anyone. Section 5 states what was and was not verified.

## 1. Implemented behavior and interface contracts

### Routes

| Route | Result |
| --- | --- |
| `GET /` | EJS feed page: filter form, first 20 matching articles, Previous/Next links. |
| `GET /api/public/articles` | `{ "items": [...], "page": N, "hasMore": true }`. |
| `GET /articles/:id` | EJS article page: full content and the first 10 comments in the initial HTML. |
| `GET /api/public/articles/:id/comments?before=<cursor>` | `200 { items, hasMore, nextBefore }`, at most 10, newest first. |
| `POST /api/public/articles/:id/comments` body `{ displayName, body }` | `201` with the created comment. |
| `PATCH /api/public/comments/:id` body `{ body }` | `200` with the updated comment. Only the text can change. |
| `DELETE /api/public/comments/:id` | `204`. |

`routes/publicRoutes.js` mounts all of these (comments through `routes/commentRoutes.js`) and attaches the device
middleware to them only. The pages load `/css/public.css`, `/js/public-feed.js` (home) and `/js/public-comments.js`
(article) from the static folder.

Flow: the controller validates input and renders EJS or JSON. `services/publicArticleService.js` is the only file that
knows the Article field names and builds the MongoDB queries. The HTML feed and the JSON feed use the same validation
(`parseFeedQuery`) and the same service function. Controllers call services directly, not their own HTTP API.

### Feed parameters (both feed routes)

| Parameter | Rule |
| --- | --- |
| `q` | Optional. One string, at most 100 characters. Title search (see "Search"). |
| `category` | Optional. One string, at most 50 characters. Exact, case-sensitive match on the approved category. |
| `viewed` | Optional. `all` (default), `viewed` or `unviewed`. Case-sensitive. |
| `sort` | Optional. `date` (default) or `popular`. Case-sensitive. |
| `page` | Optional, whole number 1 to 1000, default 1. |

`q` and `category` are trimmed; an empty value means no filter. These give HTTP 400 (`{ "error": "..." }` for the API,
an HTML message page for `/`): a repeated parameter (`q=a&q=b`); a structured form (`q[$ne]=x`, `page[]=1`; Express keeps
such keys as plain names like `q[$ne]`, so the controller rejects keys starting with `q[`, `category[`, `viewed[`,
`sort[` or `page[`); a value outside the rules above; a control character; a value over the length limit. Other unknown
parameters are ignored. A valid category with no articles returns an empty result, not an error.

Feed item: `id`, `title`, `summary`, `imageUrl` (or `null`), `category`, `authorName`, `publishedAt` (ISO string). The
article page also uses `content` and `updatedAt`. An unknown, malformed, draft-only or unapproved article id gives 404.
Unexpected failures give 500 with a generic message; details are only logged on the server. Filters and sort are applied
by MongoDB before `skip` and `limit`; the service fetches 21 rows to compute `hasMore`. Feed responses carry
`Cache-Control: private, no-cache` because they depend on the cookie.

### Public content rule

Public code reads only the approved version. An article is public when `approved.publishedAt` is a date. `status` is not
used, so an article with a pending update keeps showing its last approved version, and an article with no approved
version is never visible (direct id, search, categories, comments). Content is plain text: escaped by EJS, blank lines
become paragraphs, single line breaks are kept by CSS. Image URLs must be absolute http(s) or site-relative; anything
else is dropped. Ids are checked against an explicit 24-hex-character pattern before any query.

### Sorting

- `date`: `approved.publishedAt` descending, then `_id` descending.
- `popular`: `totalViews` descending, then `approved.publishedAt` descending, then `_id` descending.

Both end with `_id`, so equal values never give a random order. The sort works together with `q`, `category` and
`viewed` in the same database query. A public article with a pending update is ranked by its own popularity and shows
only its approved content.

C only reads `totalViews` to order the feed. It does not create, change or display it, and it is not in any response.
`totalViews` is a proposal: see section 3. The proposed meaning of popularity is the article's accumulated total of
views, with no time window and no reset between versions. This is a development assumption that has not been agreed
with B or D. Popularity can change while a reader scrolls, so later pages are not a
snapshot of the earlier order; an article can move between pages, the browser skips an id it already shows, and a
different article can be missed until the feed is reloaded. This is a known limit of page/skip/limit.

### Search

Title search uses a MongoDB text index on `approved.title` only; it is not a substring search. Checked on MongoDB 8.0
before the cleanup, with C's own test data (not part of this branch): whole words only (`harbor` matches "Harbor report", `harb` does not); case-insensitive with English
stemming (`libraries` finds "library"); several words match articles with any of them; a quoted phrase needs the whole
phrase; a leading minus excludes a word; stop words are ignored, so a query of only stop words finds nothing. Summary,
content, and pending or draft titles are never searched. With a text query the plan is a text-index scan followed by an
in-memory sort. The index uses `default_language: "english"`; MongoDB has no Hebrew stemmer (see section 4).

### Categories

The filter form lists the distinct approved categories (`getPublishedCategories()`), sorted, ignoring the active filters,
rendered with the home page (no separate categories API). Pending or draft categories never appear. A category in the URL
that is not in the list is echoed as one extra selected, escaped option so the form matches the empty result; it is never
read from the database.

### Device cookie and viewed state

`middleware/deviceIdentity.js` runs inside the public router only (static files do not get it). It sets `req.deviceId`.

| Property | Value |
| --- | --- |
| Name / value | `dw_device` / 32 lowercase hex characters from `crypto.randomBytes(16)`. |
| Lifetime | 365 days from issue; not renewed. |
| Attributes | `Path=/`, `HttpOnly`, `SameSite=Lax`, `Secure` when `req.secure` is true. |

A valid cookie is reused; a missing or malformed one is replaced in the same response (the value is matched against a
fixed pattern, never decoded). The identity comes only from the `Cookie` header; a query string, body or other header
cannot set it. It is anonymous browser state, not authentication: it grants no role. Clearing cookies creates a new
identity; browsers and profiles are separate; nothing identifies hardware or a person.

`ArticleRead` (`models/ArticleRead.js`, collection `article_reads`, default mongoose connection) is read history for one
browser. It is separate from D's view statistics.

| Field | Meaning |
| --- | --- |
| `deviceId` | The cookie value. |
| `articleId` | ObjectId of the opened article (no `ref`; B owns the Article model). |
| `readAt` | Time of the latest visit. |

Index: unique `{ deviceId: 1, articleId: 1 }` (also serves "all articles of this device"). No article content is copied.
Operations: Create and Update through one upsert in `markArticleRead` (a new record, or `readAt` updated), and Read
(the article ids of a device). There is no Delete and no HTTP endpoint for this model.

- **Marking:** `GET /articles/:id` marks the article only after the approved version was found. Malformed, missing and
  draft-only ids give 404 and are not marked. Feed requests never mark anything. If the write fails, the error is
  logged and the article is still served.
- **Filtering:** for `viewed` or `unviewed` the controller reads the device's article ids and the service adds
  `_id: { $in: ids }` or `_id: { $nin: ids }` to the same filter as the approved-only condition, `q` and `category`,
  before `skip` and `limit`. A new device has an empty list. If reading the history fails the request returns 500; it
  never falls back to the unfiltered feed.
- **Scaling limit:** the id list grows with the number of articles a device opened and is sent to MongoDB in every
  filtered query. Large histories were not measured.
- **Not handled:** deleting an article does not delete its read records or comments (needs B/D; see section 4).

### Comments

`models/Comment.js`, collection `comments`, default mongoose connection.

| Field | Meaning |
| --- | --- |
| `articleId` | ObjectId of the article (no `ref`). |
| `deviceId` | Internal owner (the cookie value). `select: false`; never in a response or in HTML. |
| `displayName` | Required, trimmed, 1 to 40 characters, no control characters. Not used for authorization. |
| `body` | Required, trimmed, 1 to 1000 characters, plain text; line breaks and tabs kept, other control characters rejected. |
| `createdAt`, `updatedAt` | Set by the server (`timestamps`); never taken from the request. |

Index: `{ articleId: 1, createdAt: -1, _id: -1 }`. Lengths are counted in JavaScript string units (an emoji counts as 2).

A comment in a response has exactly: `id`, `articleId`, `displayName`, `body`, `createdAt`, `updatedAt` (ISO strings),
`canEdit`, `canDelete`. The last two are `true` only for the device that wrote it; the server checks ownership again on
every change. There is no `GET /api/public/comments/:id`: the list is the Read operation. The list response and the
article page are sent with `Cache-Control: private, no-cache`.

Status codes: `400` invalid input (malformed JSON, a body that is not an object, a bad field or `before`); `415` a POST or
PATCH whose `Content-Type` is not `application/json` (a charset parameter is accepted); `403` the comment belongs to
another device; `404` malformed id, missing comment, or an article with no approved version (same answer for a draft, so
nothing is revealed); `413` body over 10 KB; `429` rate limit; `500` generic message. Errors are `{ "error": "..." }`.

**Operations require a public article.** Listing, creating, editing and deleting first check
`publicArticleService.isArticlePublished`. Existing comments of a draft-only or missing article cannot be read, edited
or deleted through the API, even by the author.

**Ownership policy (C's proposal, not an instructor rule).** Anyone can read comments of public articles. A device can
create comments and edit or delete only its own, using `req.deviceId`. Only `body` is written on update; every other
field in a body, query or header (including `role`) is ignored. Clearing the cookie means the comments can no longer be
edited from that browser. Editor moderation is not implemented: it needs A's server-side roles, and no fake role exists.

**Order and pagination.** Newest first by `createdAt`, then `_id`. `nextBefore` is `<createdAt in ms>_<comment id>` of the
last item; the next request sends it as `before`. Skip-based paging is not used because comments are added and deleted
while a reader is on the page.

**Rate limit** (`services/commentRateLimiter.js`): at most 3 new comments per device in any rolling 60 seconds, across all
articles. Order in `createComment`: validate, check the article is public, `reserve(deviceId)`, write to MongoDB. The
check and the reservation are one synchronous step, so simultaneous requests cannot all pass; a failed write releases its
reservation. Invalid input, nonpublic articles, edits and deletes never use or return a slot. Over the limit the answer is
`429` with `Retry-After: <seconds>` and `{ error, retryAfterSeconds }`. Expired entries are dropped when the device posts
again, and other devices are swept lazily, so the map may briefly hold expired entries.
Limits: counters are in memory, so they reset on restart; each server process has its own counters (several processes
allow 3 each); clearing the cookie or using another browser gives a fresh quota. The requirements do not say the limit
must survive a restart or work across processes, so this fits a single-process course application. Otherwise it would
need an atomic shared counter in MongoDB.

**Cross-site writes.** No CSRF token. POST and PATCH need `Content-Type: application/json`, checked in
`routes/commentRoutes.js` before the JSON parser and the controller (the shared server's `express.urlencoded()` fills
`req.body` from a plain HTML form, so an empty body is not a reliable test). No CORS headers are sent and the cookie is
`SameSite=Lax`. If A adds a project-wide CSRF mechanism, it should apply to these routes too.

### Browser scripts

- `public-feed.js`: the first 20 articles are server-rendered and page 1 is not requested again. Submitting the form or
  changing a select reloads the feed through the API, resets to page 1 and updates the address bar; more pages load
  within 600px of the bottom. Answers to older requests are ignored; after an error the user presses "Try again". API
  text is inserted with `textContent`. `createCard()` mirrors the card markup in `views/public/home.ejs`: keep them in sync.
- `public-comments.js`: the first 10 comments are rendered by EJS. Posting adds the server's returned record without
  refetching the list; edit and delete change only that item; "Load more" uses `before` and skips ids already shown. The
  form is a `<fieldset disabled>` in the HTML and the script enables it only after its handler is attached, so it can
  never be sent as a native GET. `createCommentItem()` mirrors `views/public/article.ejs`: keep them in sync.
- Both are classic scripts with top-level declarations. If A adds a script to the same pages that declares the same
  names, the browser reports a redeclaration error.
- All public CSS is scoped under `.pub-site`, so it should not change staff pages. `views/public/partials/` and the header
  rules (`.pub-header`, `.pub-brand`) are temporary and should give way to A's shared partials.

## 2. Indexes proposed for B's Article schema (proposal)

Proposed for B's schema, using the field names in section 3:

| Index | Used by |
| --- | --- |
| `{ "approved.publishedAt": -1, _id: -1 }` | Feed without filters. |
| `{ "approved.category": 1, "approved.publishedAt": -1, _id: -1 }` | Category filter. |
| `{ "approved.title": "text" }`, `default_language: "english"` | Title search. Required: a `$text` query fails without it. |

MongoDB allows one text index per collection. Queries with `q` use only the text index; `category` is applied to its
matches. Indexes must exist before the first search request. For `sort=popular`, an index starting with `totalViews: -1`
reduced the work in local measurements, but it is not proposed yet: it depends on real data size and on how `totalViews`
is maintained (every change to the value also updates that index). B, D and C should decide this together.

## 3. Connections needed from A, B and D (proposals, not agreements)

**A**
- Mount `routes/publicRoutes.js` before `express.static`; otherwise `public/index.html` answers `GET /`.
- Set the EJS view engine. The template root must be the project's `views` folder (the one that contains `public/`),
  not the project root: the controllers render `public/home`, `public/article` and `public/message`. The static
  folder must serve `public/css/public.css` and `public/js/public-feed.js`, `public-comments.js` at `/css/...` and
  `/js/...`. A's error handler may replace the try/catch in the controllers.
- Coordinate the middleware order for the comment routes. They rely on three things: the `Content-Type` check
  (415), the 10 KB limit (413) and JSON error answers (400/413). The JSON parser (`express.json({ limit: "10kb" })`)
  is attached only to the two routes that read a body, and the router has its own error handler. A global body parser
  that reads the body before these routes may prevent the local parser from enforcing the limit, and an HTML error
  page in front of them would hide the JSON answers. Check this during integration. C does not ask to remove parsers
  from the rest of the system.
- Connect mongoose before the first request and call `useArticleModel(Article)` (from `services/publicArticleService.js`)
  once at startup with B's model.
- Make sure the unique `ArticleRead` index and the `Comment` index exist before serving: with `autoIndex` on (the
  default) `init()` waits for them; with `autoIndex` off, call `createIndexes()` on both models.
- `req.secure` decides whether the cookie gets `Secure`. Behind an HTTPS proxy it is right only if A configures Express
  `trust proxy` for the real topology (`1` fits exactly one trusted proxy). C does not set this.
- Roles and sessions would be needed for editor comment moderation (section 4).

**B**
- Confirm or replace the field names C reads: `approved: { title, summary, content, category, imageUrl, authorName,
  publishedAt, updatedAt }` next to a separate `pending` revision. They live only in
  `services/publicArticleService.js`.
- Add the indexes in section 2.
- Give articles a numeric `totalViews` (default 0) if D keeps the total on the article. An article without the field
  sorts last under `popular`.

**D**
- `recordArticleView(articleId)` is not called. The call site is marked in `renderArticle` in
  `controllers/publicController.js`. D's counters ("how many views over time") and C's `ArticleRead` ("did this browser
  open the article") stay separate; neither reads the other.
- C needs only a number such as `totalViews` on the article. If D keeps counts elsewhere (for example per hour in another
  collection), tell C, because sorting by a value from another collection needs a different query.
- Comments seed: C provides no comment fixtures. A seeded comment needs `articleId` (an article with an approved
  version), `displayName` (1 to 40 characters), `body` (1 to 1000), `createdAt`, `updatedAt` and a `deviceId` that is any
  32-character lowercase hex string (random, not a real reader's cookie). Back-dated `createdAt` needs `timestamps: false`
  (or a raw insert). Comments of deleted or draft-only articles are never shown.

### Example connection order (a proposal only, A decides the real structure)

Illustrative sketch of the order that the notes above assume. It is not code from this branch and not an agreed design.

```js
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));   // the folder that contains views/public/

await mongoose.connect(process.env.MONGODB_URI);  // A's connection and variable name
await Article.init();                             // B's model; the text index must exist before the first search
await ArticleRead.init();
await Comment.init();
useArticleModel(Article);                         // from services/publicArticleService.js

app.use(publicRoutes);                            // routes/publicRoutes.js, before the global parsers and express.static
app.use(express.json());                          // the rest of the application as A designs it
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));
```

If the global parsers must stay first, check the comment-route behavior listed below before accepting it.

### Short checks after connecting (suggested)

1. `GET /` answers 200 with at most 20 article cards in the HTML, and the page works without JavaScript.
2. `GET /api/public/articles?page=1` returns `items` (at most 20) and `hasMore`.
3. An article with a pending update shows its approved version in the feed, in search and on its page. A draft-only
   article gives 404 on its page and never appears in the feed, search, categories or comments.
4. `?q=<a word from a title>` returns results and not a 500 (the text index exists).
5. Opening an article sets the `dw_device` cookie, and the article then appears under `viewed=viewed` in that browser.
6. A comment can be posted, edited and deleted from the same browser; a browser with another cookie gets 403 on edit and
   delete.
7. The fourth comment within a minute from one browser gets 429 with a message.
8. A comment request with the wrong `Content-Type` gets 415, malformed JSON gets a JSON 400, and a body over 10 KB gets a
   JSON 413. This confirms that the middleware order does not bypass the local parser.
9. `sort=popular` follows `totalViews` only after D provides it; without the field it behaves like the date order.
10. Staff pages look unchanged (the public CSS is scoped under `.pub-site`).

## 4. Open questions (not requirements)

These are questions for the team and the course material. None of them is a new task unless the team decides so.

- Is `ArticleRead` acceptable as C's own model, next to D's "view data and statistics" model? It has Create/Update
  (upsert) and Read, but no Delete and no endpoint. Does the course require more for it?
- Do comments need a search or a read-by-id route, or is the list enough as the Read operation?
- Should editors moderate comments (needs A's roles), and is the same-device ownership policy acceptable?
- Is a CSRF mechanism wanted for the project?
- Hebrew content: should the text index use `default_language: "none"` (whole-word match, no stemming)? Examples would
  need re-checking.
- Who deletes comments and `ArticleRead` records when an article is deleted (B or D)?
- Where does `totalViews` come from, and is an index for it worth its write cost?
- Which techniques used here were covered in the course: `crypto.randomBytes`, cookie options, `$in`/`$nin`, upsert, a
  compound unique index, `fetch`, `history.replaceState`, a MongoDB text index, `explain()`? C did not confirm this.

## 5. Verification limits

The earlier verification was done before the cleanup, on C's local branch, with temporary development tooling (a test
database fixture, a demo server, a seed, automated tests and a measurement script) that is no longer in this branch. It
covered automated tests against MongoDB 8.0, a manual pass in the embedded browser, and one set of query measurements on
5000 generated articles. It is not verification of the current version after the cleanup, and no integrated-system test
has been run. The measurements are local and limited (one machine, one client, synthetic data, warm cache); they do not
show behavior under load. The automated tests are not part of this branch, so the checks in section 3 are the way to
confirm C after the connection. Detailed history is kept privately by C and is not part of the repository.

Not verified: integration with the real A, B and D code (the interfaces above are proposals); other browsers or real
phones; a browser with JavaScript fully switched off; a second real device; behavior behind an HTTPS proxy; the limiter
after a restart or with several processes; the `ArticleRead` lookup with large histories; `sort=popular` above 5000
articles or with a real `totalViews` counter; any concurrent load. The rolling window of the rate limiter was tested with
a fake clock, not by waiting over HTTP.
