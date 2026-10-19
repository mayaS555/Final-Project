# Person B – Articles, workflow and reporter area

What B built, how A, C and D connect to it, and how to demo it. Sections: [checklist for C](#what-c-asked-of-b) ·
[files](#files) · [data model](#data-model) · [workflow](#workflow) · [for D](#for-person-d) ·
[HTTP](#http-api-and-pages) · [for A](#for-person-a) · [seed](#seed-data) · [tests](#tests) ·
[demo](#how-to-demo-person-b) · [open points](#differences-from-cs-doc-and-open-points) · [README text](#readme-section-for-a).

## What C asked of B

From `docs/person-c-integration.md` (section 3, "B", plus the public rule in section 1 and the open questions in
section 4):

| C asked | Status |
| --- | --- |
| Public fields `approved: { title, summary, content, category, imageUrl, authorName, publishedAt, updatedAt }` | **Done.** Exactly these names; C's service works unchanged. |
| A separate `pending` revision next to `approved` | **Changed:** it is called `draft` (the working copy). C never reads it. |
| Index `{ "approved.publishedAt": -1, _id: -1 }` | **Done.** |
| Index `{ "approved.category": 1, "approved.publishedAt": -1, _id: -1 }` | **Done.** |
| Text index on `approved.title`, `default_language: "english"` | **Done.** |
| Numeric `totalViews`, default 0 (if D keeps the total on the article) | **Done.** D increases it with `$inc`. |
| Index for `totalViews` | **Not added**, as C suggested, until D settles how the counter is written. |
| Public = `approved.publishedAt` is a date; `status` ignored | **Done**, also as `Article.publicFilter()`. |
| Who deletes comments and read history when an article is deleted | **Open** (B, C, D). `deleteArticle` deletes only the article. |
| Hebrew text index (`default_language: "none"`)? | **Not changed.** The index stays English; the seed text is English. |

## Files

| Path | What |
| --- | --- |
| `models/Article.js`, `models/articleCategories.js` | Schema, indexes, `Article.publicFilter()`; the category list. |
| `services/articleStatus.js` | State machine: allowed transitions and who may edit or delete. Pure functions. |
| `services/articleService.js` | The only code that changes `status` or `approved`. Used by B's and D's controllers. |
| `middleware/articleAccess.js` | Login stand-ins, `loadArticle`, `requireArticleOwnerOrEditor`, `getSessionUser`. |
| `routes/articleApiRoutes.js`, `controllers/articleApiController.js` | REST API under `/api/articles`. |
| `routes/reporterRoutes.js`, `controllers/reporterController.js`, `views/reporter/*.ejs` | Dashboard and edit page. |
| `public/js/reporter-*.js`, `public/css/reporter.css` | Dashboard actions, autosave, submit; styles. |
| `scripts/seed.js` | `npm run seed`: 500 articles. |
| `tests/*.test.js` (B's), `tests/testDatabase.js`, `tests/testServer.js`, `tests/fakeEditPage.js` | Tests and their helpers. |

## Data model

Collection `articles`. Each article has a **public version** (`approved`, changed only by approval) and a **working
copy** (`draft`, edited by the reporter and the editor, never public).

| Field | Type | Meaning |
| --- | --- | --- |
| `author` | ObjectId, `ref: "User"` | The reporter who owns it. |
| `authorName` | String | The author's display name, copied from the user when the draft is created. |
| `status` | `draft` \| `pending` \| `returned` \| `published` | State of the working copy (default `draft`). |
| `draft` | sub-document | Working copy. Every field defaults to `""` (autosave stores partial work). |
| `approved` | sub-document, absent until the first approval | Public version. |
| `editorNote` | String, max 1000 | The editor's reason for returning it. |
| `publishCount` | Number, default 0 | How many times it was approved. |
| `totalViews` | Number, default 0 | Page views, kept by D. C sorts `popular` by it. |
| `createdAt`, `updatedAt` | Date (`timestamps`) | Change on every save, drafts included. Not public. |

Content fields, in both `draft` and `approved`: `title` (max 200), `summary` (max 500), `content` (plain text, max
50000; a blank line separates paragraphs), `imageUrl` (max 2048), `category`. All except `content` are trimmed.
`category` is one of `General, Politics, World, Economy, Technology, Sports, Culture, Health`; in `draft` it may
also be `""`. Required fields (`title`, `content`, `category`) are checked on submit, not by the model.

Only in `approved`: `authorName` (copied from the article's `authorName` at approval, so C needs no join),
`publishedAt` (first approval; feed order) and `updatedAt` (latest approval; C's article page shows it).

**Public filter.** An article is public when `approved.publishedAt` is a date; `status` is ignored, so an article
being revised keeps showing its approved version.
`Article.publicFilter()` returns `{ "approved.publishedAt": { $type: "date" } }`, a new object on each call.

| Index | Used by |
| --- | --- |
| `{ "approved.publishedAt": -1, _id: -1 }` | C: feed by date, public filter |
| `{ "approved.category": 1, "approved.publishedAt": -1, _id: -1 }` | C: category filter |
| `{ "approved.title": "text" }`, English | C: title search (`$text` fails without it) |
| `{ author: 1, updatedAt: -1 }` | B: reporter dashboard |
| `{ status: 1, updatedAt: -1 }` | D: editor dashboard |

## Workflow

**Transitions** (`services/articleStatus.js`). Anything else is rejected.

| From | To | By | Action |
| --- | --- | --- | --- |
| `draft` | `pending` | reporter | submit |
| `returned` | `pending` | reporter | resubmit |
| `pending` | `published` | editor | approve |
| `pending` | `returned` | editor | return |
| `published` | `draft` | reporter | startRevision |

| Rule | Allowed |
| --- | --- |
| `canTransition(from, to, role)` | Only a row above, by its own role. |
| `assertTransition(from, to, role)` | Throws with `error.status` `403` (wrong role) or `409` (no such change). |
| `canEditWorkingCopy(status, role, isOwner)` | Reporter: own article in `draft`/`returned`. Editor: any article in `pending`. |
| `canDelete(article, role, isOwner)` | Editor: any. Reporter: own, `draft`/`returned`, never published. |

Role names are `"reporter"` and `"editor"`. Callers decide `isOwner` and check ownership for reporter transitions.

**Service functions** (`services/articleService.js`). Each takes a loaded article document and the acting `user`
(`{ _id, role, name }`), saves, and returns the updated document. Errors carry `error.status`: `400` bad input,
`403` not allowed, `409` wrong status or changed meanwhile. Database errors are rethrown.

| Function | Does |
| --- | --- |
| `createDraft(user)` | Reporter only: a new empty draft. |
| `saveWorkingCopy(article, user, fields)` | Saves `title`, `summary`, `content`, `imageUrl`, `category` to `draft`. Other keys: `400`. |
| `submit(article, user)` | Author: `draft`/`returned` → `pending`. Needs title, content, category. Clears `editorNote`. |
| `approve(article, editor)` | `pending` → `published`. Copies `draft` into `approved`, sets the dates, adds 1 to `publishCount`. Returns `{ article, isFirstPublish }`. |
| `returnToReporter(article, editor, note)` | `pending` → `returned`. Note required, trimmed, max 1000. |
| `startRevision(article, user)` | Author: `published` → `draft`, copying `approved` into `draft`. The public version stays. |
| `deleteArticle(article, user)` | Deletes if `canDelete` allows. |
| `listArticles(user, status?)` | Dashboard list: own articles (reporter) or all (editor), last changed first. |

Saves and status changes are written with a status condition (`findOneAndUpdate({ _id, status })`; delete uses
`deleteOne` the same way). A double click, or an autosave that arrives after submit, gets `409` instead of applying
twice. Submit, approve, return and delete are logged as `[article] <event> article=<id> by=<user id> (<role>)`
(`console.log` until A's logger exists).

## For Person D

- Load the article (`Article.findById`; `404` if missing), call the service with the session user, and let errors go
  to `next(err)`. Never set `status`, `approved` or `publishCount` yourself.
- `approve(article, editor)` returns `{ article, isFirstPublish }`. The publish-event hook is marked
  `// Person D hooks in here` inside `approve()`.
- `returnToReporter(article, editor, note)`: an empty or too-long note gives `400`, and the article stays `pending`.
- `deleteArticle(article, editor)` deletes any article (not its comments or read history; see open points).
- An editor can fix a pending article before approving: `saveWorkingCopy(article, editor, fields)`, or open
  `/reporter/articles/:id/edit`.
- Editor list: `GET /api/articles?status=pending` (uses the `{ status, updatedAt }` index).
- `totalViews`: increase with `$inc`. For "visible to the public" use `Article.publicFilter()`.
- Seeded articles with several approvals: `{ publishCount: { $gte: 2 } }` (see [seed](#seed-data)).

## HTTP: API and pages

**Middleware** (`middleware/articleAccess.js`). Route order: login → `loadArticle` → `requireArticleOwnerOrEditor` →
controller.

| Function | Does |
| --- | --- |
| `requireStaffLogin`, `requireReporterLogin` | Stand-ins for A's login/role middleware: `401` nobody logged in, `403` other role. |
| `loadArticle` | `:id` must be 24 hex characters (`400`); loads the article (`404`) into `req.article`. |
| `requireArticleOwnerOrEditor` | An editor, or the reporter who wrote `req.article`; otherwise `403`. |
| `getSessionUser(req)` | The session user, or `null`. Reads `req.session.user` only (never the body, query or headers). |

**REST API** (JSON; a logged-in reporter or editor; `:id` routes also need the author or an editor). `POST` and
`PATCH` must be `application/json` (otherwise `415`), so a form on another site cannot use the session cookie.
There are **no approve or return routes**: those are D's.

| Route | Answer |
| --- | --- |
| `POST /api/articles` | `201` + new draft (editors: `403`) |
| `GET /api/articles?status=` | `200 { items: [{ id, title, publicTitle, status, editorNote, updatedAt, publishedAt }] }` |
| `GET /api/articles/:id` | `200` + article |
| `PATCH /api/articles/:id` | `200 { savedAt }` (autosave) |
| `DELETE /api/articles/:id` | `204` |
| `POST /api/articles/:id/submit` | `200` + article (also resubmit) |
| `POST /api/articles/:id/revise` | `200` + article |

Article in a response: `{ id, status, authorId, authorName, draft: { title, summary, content, imageUrl, category },
approved: { …, authorName, publishedAt, updatedAt } | null, editorNote, publishCount, createdAt, updatedAt }`.

**Reporter dashboard** (`GET /reporter`, reporters only). It is rendered on the server, and `?status=` tabs filter
it. Each row shows the title (working title, else the public title, else "Untitled"), the category, a Hebrew
status badge (בהכנה, ממתינה לאישור עורך, פורסמה, הוחזרה לתיקונים) and the last change. It also shows the editor's
note when the article was returned, and a "new version in progress" note when a published article is being revised.

| Action | Shown when | Does |
| --- | --- | --- |
| New article | always | `POST /api/articles`, then the edit page |
| Edit | `draft` or `returned` | link to the edit page |
| View live | it has a public version | link to C's `/articles/:id` |
| Edit published article | `published` | `POST …/revise`, then the edit page |
| Delete | never-published `draft`/`returned` | `confirm()`, `DELETE`, row removed without reload |

The buttons are disabled until the script loads and while their request runs. `?msg=submitted` and
`?msg=resubmitted` show a fixed message (unknown keys show nothing), then `msg` is removed from the address.

**Edit page** (`GET /reporter/articles/:id/edit`, for the author or an editor; another reporter gets `403`).

- **What it shows.** The working copy, read from the database on every request (`Cache-Control: private,
  no-store`). Category is a `<select>` built from `ARTICLE_CATEGORIES`.
- **Read-only, not an error.** When the user may not edit in the current status, the page still loads, with the
  fields disabled and the reason shown.
- **Messages.** A returned article shows the editor's note at the top. A public article shows "Readers still see the
  published version until an editor approves your changes".
- **Autosave** (`reporter-autosave.js`):
  - **When.** It sends the changed fields with `PATCH` 1.5 s after the last keystroke, one save at a time. The
    status line shows "Saving…", "Saved at HH:MM" or "Offline – will retry".
  - **Failures.** Network errors and 5xx are retried after 2, 4 and 8 s, then every 15 s. A `400` shows the
    server's message. A `401`, `403` or `409` stops autosave, locks the form and asks the user to reload.
  - **Leaving the page.** When the page is hidden or closed, pending changes are sent at once with `keepalive`.
    "Leave site?" appears only when they could not be sent.
  - **No local copy.** Nothing is kept in localStorage; the server is the only copy.
- **Submit / Resubmit** (`reporter-edit.js`, for the author only):
  - **Order.** It locks the form, runs `saveAllNow()`, then sends `POST …/submit`. On success it opens the dashboard
    with a message.
  - **400.** It names the empty fields by their labels and marks them. The required list is passed from the service
    as `data-required-fields`.
  - **403 / 409.** It shows the server's message and asks the user to reload.

## For Person A

Add to `server.js`, after the session middleware and before `express.static` and the error middleware:

```js
app.use(require("./routes/articleApiRoutes"));
app.use(require("./routes/reporterRoutes"));
```

- **EJS.** Set `app.set("view engine", "ejs")`, with `views` as the template root (the same setting C needs).
- **Startup.** Connect mongoose, run `await Article.init()` before the first request (the text index), and call
  `useArticleModel(Article)` from C's `publicArticleService`.
- **JSON parser.** Mount these routers before the global `express.json()`, or raise its limit. The default 100 KB
  answers `413` for a long article; the API router has its own 200 KB parser.
- **Session user.** Assumed at `req.session.user = { _id, role, name }`, with roles `"reporter"` and `"editor"`;
  `name` is the byline. It is read only in `getSessionUser`, so a different shape is a one-line change there.
- **Login middleware.** Replace `requireStaffLogin` and `requireReporterLogin` with A's middleware, then delete them.
- **After login.** Send reporters to `/reporter`.
- **Errors.** B's errors carry `error.status` (`400`, `401`, `403`, `404`, `409`, `415`). Send `error.message` for
  4xx: JSON for `/api/*`, a page otherwise. On the reporter pages, redirecting a 401 to the login page is friendlier.
- **Layout.** The reporter pages use C's temporary partials (`views/public/partials/top`, `bottom`) and load
  `/css/reporter.css` in the body. When A's shared layout exists, switch the two includes and move the stylesheet
  into the head.
- **User model.** It must be registered as `"User"` (the `ref` in `models/Article.js`).
- **Files of A's that B touched.** `package.json` has one added line (`"seed"`). `.env.example` is new
  (`MONGODB_URI`, `NODE_ENV`); A can extend it.

## Seed data

`npm run seed` (`scripts/seed.js`) replaces all articles with 500 generated ones in about a second.

- **Safety.** It reads `MONGODB_URI` from `.env` and refuses to run with `NODE_ENV=production`. It warns, then
  deletes **only** `articles`; comments, read history, views and publish events are not touched.
- **Repeatable and real-shaped.**
  - A fixed random seed builds the same articles every run; only the dates follow the current time.
  - The documents have the same fields as articles published through the service (a test checks this).
  - One `insertMany` validates every document and keeps the seed's dates.
- **Mix.** 275 published, 75 pending, 50 pending revisions of published articles (still public with the old text),
  50 drafts (half of them half written) and 50 returned with a note.
- **Spread.** Every category has every reporter and every state; published dates cover the last 60 days.
- **Text and images.** English text (C's search uses the English text index). `imageUrl` is empty, so C's feed
  shows its placeholder. `totalViews` is 0.
- **For D.** 15 articles were approved 2–5 times: `{ publishCount: { $gte: 2 } }`. For each, `approved.publishedAt`
  is the first approval and `approved.updatedAt` the latest. The approvals in between are not stored, so D's seed
  can spread its publish events between the two dates.
- **Users.** None yet, because A has no User model or hashing. The articles use 5 fixed reporters (ids
  `665000000000000000000001`–`…005`, printed at the end). When A merges, the seed will create them and one editor
  through A's model, with passwords from `.env`.
- **Order.** Run B's seed first. C and D have no seeds yet; theirs should read the existing articles
  (`Article.find(Article.publicFilter())`).

## Tests

`node --test` runs all tests. The database tests also need `MONGODB_TEST_URI`, with "test" in the database name
(each test process uses its own database and drops it). Without it they are skipped.

| File | Covers |
| --- | --- |
| `articleStatus`, `articleModel`, `articleService` | State machine, schema and indexes, every service rule; C's queries on the real model |
| `articleAccess`, `articleApi` | Middleware; every API route over HTTP |
| `reporterDashboard`, `reporterEdit` | Both pages: rows, actions, read-only cases, escaping, messages |
| `reporterAutosave`, `reporterEditSubmit`, `reporterDashboardScript` | The browser scripts, run in Node's `vm` with a fake page |
| `seed` | The generated mix, shape, dates, production refusal; C's feed and search on seeded data |

`scripts/check-article-status.js` is the first, standalone version of the state-machine check. `articleStatus.test.js`
covers the same and more.

## How to demo Person B

**Before you start.**
- A's server runs with B's routers mounted, and a reporter can log in.
- MongoDB runs, and `MONGODB_URI` names the app's database.
- D's editor UI isn't merged, so the editor steps use these temporary commands, which call the same service
  functions D will. Run them from the project folder. `<ARTICLE_ID>` is the long part of the edit page address.

Editor returns the article with a note:

```bash
MONGODB_URI="mongodb://127.0.0.1:27017/<database>" node -e '
const mongoose = require("mongoose");
const Article = require("./models/Article");
const { returnToReporter } = require("./services/articleService");
const [id, note] = process.argv.slice(1);
const editor = { _id: new mongoose.Types.ObjectId(), role: "editor", name: "Demo editor" };
mongoose.connect(process.env.MONGODB_URI)
  .then(async () => console.log("status:", (await returnToReporter(await Article.findById(id), editor, note)).status))
  .catch((error) => console.error("Failed:", error.message))
  .finally(() => mongoose.disconnect());
' <ARTICLE_ID> "Please add the vote count."
```

Editor approves the article:

```bash
MONGODB_URI="mongodb://127.0.0.1:27017/<database>" node -e '
const mongoose = require("mongoose");
const Article = require("./models/Article");
const { approve } = require("./services/articleService");
const [id] = process.argv.slice(1);
const editor = { _id: new mongoose.Types.ObjectId(), role: "editor", name: "Demo editor" };
mongoose.connect(process.env.MONGODB_URI)
  .then(async () => {
    const { article, isFirstPublish } = await approve(await Article.findById(id), editor);
    console.log("status:", article.status, "| first publish:", isFirstPublish, "| publishCount:", article.publishCount);
  })
  .catch((error) => console.error("Failed:", error.message))
  .finally(() => mongoose.disconnect());
' <ARTICLE_ID>
```

They print `status: returned` or `status: published | first publish: …`. A wrong state prints the state machine's
message, for example `Failed: An article cannot go from returned to published.`

| # | Do | Expect |
| --- | --- | --- |
| 1 | Log in as a reporter. | `/reporter`: "You have no articles yet". |
| 2 | **New article**. | Edit page, badge "בהכנה", "Changes are saved automatically." |
| 3 | Type a title, wait ~2 s, reload. | "Saving…" → "Saved at HH:MM"; the title survives the reload. |
| 4 | **Submit for approval** with text and category empty. | "Please fill in: Article text, Category.", both outlined in red. Nothing sent. |
| 5 | Fill in summary, text and category; **Submit** right away. | Typing is saved first; dashboard: "Your article was sent to the editors for approval.", "ממתינה לאישור עורך". |
| 6 | Open the article; open `/articles/<ARTICLE_ID>`. | Edit page read-only ("waiting for an editor"); C's page: "Article not found". |
| 7 | **Editor returns** with a note; reload the dashboard. | "הוחזרה לתיקונים" and the note in the row. |
| 8 | **Edit**. | Note at the top, button **Resubmit**. |
| 9 | Fix the text; **Resubmit**. | "Your corrected article was sent to the editors again." |
| 10 | **Editor approves**. | `first publish: true`; dashboard "פורסמה" with **View live** and **Edit published article**. |
| 11 | **View live**; home page; `/?q=<a word of the title>`. | C's page shows it, "By <reporter name>"; it is in the feed and the search. |
| 12 | **Edit published article**; change the title. | Edit page "בהכנה" with the "Readers still see the published version…" banner. |
| 13 | Reload C's article page. | Still the **old** title. |
| 14 | **Submit for approval**; **Editor approves**. | `first publish: false`, `publishCount: 2`. |
| 15 | Reload C's article page. | The **new** title; the publish date is unchanged. |

Also worth showing:
- **Close quickly.** Type, close the tab within a second, reopen: the text is there.
- **Another browser.** Same text.
- **Offline** (devtools → Network → Offline): "Offline – will retry", and closing asks "Leave site?".
- **Another reporter's URL.** `403`.

Checked by B: steps 1–15 were run against a stand-in server mounting C's real public routes, B's routers, EJS and the
static files, with an in-memory MongoDB. The browser scripts are covered by the `vm` tests. Click through once in a
real browser when A's login exists.

## Differences from C's doc and open points

- **Working copy name.** C's `pending` revision is called `draft`. The sub-document `draft` and `status: "draft"` are
  different things: an article being revised has both.
- **Category.** It is limited to a fixed list. C's filter accepts any text; an unknown category returns an empty feed.
- **Latest approval date.** `approved.updatedAt` is the latest approval; there is no separate `lastPublishedAt`.
- **Optional for C.** `approvedOnlyFilter` in C's `publicArticleService.js` duplicates `Article.publicFilter()`;
  C can switch to `getArticleModel().publicFilter()`. B has not changed C's file.
- **Open:** deleting an article leaves its comments and read history (B, C, D to decide who cleans up).
- **Open:** if an editor edits a pending article in one tab while approving it in another at the same moment,
  the edit made in that instant may not reach the approved version.

## README section for A

Ready to paste into `README.md` (A owns it):

~~~markdown
## Articles & reporter area

Reporters write articles; editors approve them before they appear on the public site.

- **Reporter dashboard:** `/reporter` lists your articles with their status (בהכנה, ממתינה לאישור עורך, פורסמה,
  הוחזרה לתיקונים), the editor's note on returned articles, and the actions you may use: New article, Edit, View live,
  Edit published article, Delete.
- **Edit page:** `/reporter/articles/:id/edit`. Changes are saved automatically about 1.5 seconds after you stop
  typing, and when you leave the page. **Submit for approval** (or **Resubmit**) sends the article to the editors.
- **Workflow:** draft → pending → published, or pending → returned → pending. A published article can be revised
  ("Edit published article"); readers keep seeing the published version until an editor approves the new one.
- **API:** `/api/articles` (create, list, read, autosave, delete, submit, revise). Approve and return are on the
  editor side.
- All permission and state checks happen on the server. Details: `docs/person-b-integration.md`.

## Seeding

```bash
cp .env.example .env    # set MONGODB_URI (with the database name)
npm run seed
```

Replaces all articles with 500 sample articles in every state (275 published, spread over the last 60 days, in all
categories). It deletes only the articles collection and refuses to run when `NODE_ENV=production`.

## Tests

```bash
node --test                                                                # without a database
MONGODB_TEST_URI="mongodb://127.0.0.1:27017/daily-web-test" node --test    # all tests
```
~~~
