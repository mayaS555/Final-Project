# Person B - Article model handoff

## Summary

`models/Article.js` (collection `articles`) and `models/articleCategories.js`. Each article holds a public version
(`approved`) and a working copy (`draft`). The field names inside `approved` are exactly the ones C's
`services/publicArticleService.js` already reads, so C's code works with this model unchanged.

`services/articleStatus.js` holds the status rules (pure functions, no database). `services/articleService.js` is the
only code that changes `status` or `approved`; controllers call it and never set those fields themselves. Not done
yet: the Article API, the reporter area and the seed.

## Fields

| Field | Type | Meaning |
| --- | --- | --- |
| `author` | ObjectId, `ref: "User"`, required | The reporter who owns the article. |
| `authorName` | String, required | The author's display name, copied from the user when the draft is created. Approval copies it into `approved.authorName`. |
| `status` | `draft` \| `pending` \| `returned` \| `published`, default `draft` | State of the working copy. |
| `draft` | sub-document, see below | Working copy. Edited by the reporter and the editor. Never public. |
| `approved` | sub-document, see below, absent until the first approval | Public version. Changed only by approval. |
| `editorNote` | String, default `""`, max 1000 | The editor's reason when the article was returned. |
| `publishCount` | Number, default 0 | How many times the article has been approved. |
| `totalViews` | Number, default 0 | Total page views. D increases it. C sorts `popular` by it. |
| `createdAt`, `updatedAt` | Date (`timestamps`) | Change on every save, including drafts. Not public. |

Content fields, in both `draft` and `approved`:

| Field | Rule |
| --- | --- |
| `title` | trimmed, max 200 |
| `summary` | trimmed, max 500 |
| `content` | plain text, max 50000. Blank lines separate paragraphs on C's page. |
| `imageUrl` | trimmed, max 2048 |
| `category` | one of `ARTICLE_CATEGORIES` (`models/articleCategories.js`). In `draft` it may also be `""`. |

In `draft` every field defaults to `""`, because autosave stores partial work. Required fields are checked when the
article is submitted, not in the model.

Fields that exist only in `approved`:

| Field | Meaning |
| --- | --- |
| `authorName` | Copied from the author's user at approval, so the public site needs no join. |
| `publishedAt` | First approval. Feed order. Its presence makes the article public. |
| `updatedAt` | Latest approval. C's article page shows it. Not the same as the top-level `updatedAt`. |

Categories: `General, Politics, World, Economy, Technology, Sports, Culture, Health`.

## Public filter

An article is public when `approved.publishedAt` is a date. `status` is ignored, so an article with open changes
keeps showing its approved version.

```js
Article.publicFilter() // { "approved.publishedAt": { $type: "date" } }, a new object each call
```

## Indexes

| Index | Used by |
| --- | --- |
| `{ "approved.publishedAt": -1, _id: -1 }` | C: feed by date, public filter. |
| `{ "approved.category": 1, "approved.publishedAt": -1, _id: -1 }` | C: category filter. |
| `{ "approved.title": "text" }`, `default_language: "english"` | C: title search. `$text` fails without it. |
| `{ author: 1, updatedAt: -1 }` | B: reporter dashboard. |
| `{ status: 1, updatedAt: -1 }` | D: editor dashboard. |

There is no `totalViews` index. As C's doc suggests, add it only after D settles how the counter is written.

## Status state machine (`services/articleStatus.js`)

Every allowed change is listed below. Any other change is rejected.

| From | To | By | Action |
| --- | --- | --- | --- |
| `draft` | `pending` | reporter | submit |
| `returned` | `pending` | reporter | resubmit |
| `pending` | `published` | editor | approve |
| `pending` | `returned` | editor | return |
| `published` | `draft` | reporter | startRevision |

| Function | Rule |
| --- | --- |
| `canTransition(from, to, role)` | `true` only for a row above, done by its own role. |
| `assertTransition(from, to, role)` | Throws an `Error` with `error.status`: `403` when the change exists but belongs to the other role, `409` when it does not exist. |
| `canEditWorkingCopy(status, role, isOwner)` | Reporter: their own article in `draft` or `returned`. Editor: any article in `pending`. |
| `canDelete(article, role, isOwner)` | Editor: any article. Reporter: their own article in `draft` or `returned` that was never published. |

The rules use the role names `"reporter"` and `"editor"`. Callers decide `isOwner` (`String(article.author) === String(userId)`)
and must check ownership for reporter transitions themselves. A published article stays public while it is in
`draft`, `pending` or `returned` again, because the public filter reads `approved.publishedAt`, not `status`.

Self-check: `node scripts/check-article-status.js`.

## Workflow service (`services/articleService.js`)

Each function takes an article document that the controller has already loaded, plus the acting `user`
(`{ _id, role, name }` from the session). It saves the change and returns the updated document. Errors are thrown with
`error.status` (`400` bad input, `403` not allowed, `409` wrong status or changed meanwhile); database errors are
rethrown as they are.

| Function | What it does |
| --- | --- |
| `createDraft(user)` | Reporter only. A new, empty article in `draft`, owned by the user. |
| `saveWorkingCopy(article, user, fields)` | Saves `title`, `summary`, `content`, `imageUrl`, `category` to `draft` (manual save and autosave). Any other key gives `400`. Allowed by `canEditWorkingCopy`. |
| `submit(article, user)` | Author only. `draft` or `returned` to `pending`. Needs `title`, `content` and `category`. Clears `editorNote`. |
| `approve(article, editor)` | `pending` to `published`. Copies `draft` into `approved`, sets `publishedAt` on the first publish and `updatedAt` every time, and adds 1 to `publishCount`. Returns `{ article, isFirstPublish }`. |
| `returnToReporter(article, editor, note)` | `pending` to `returned`. The note is required, trimmed, at most 1000 characters. |
| `startRevision(article, user)` | Author only. `published` to `draft`. Copies `approved` into `draft`. The public version stays online and unchanged. |
| `deleteArticle(article, user)` | Deletes the article if `canDelete` allows it. Returns nothing. |

Every change is written with `findOneAndUpdate({ _id, status: <status when loaded> })`. A second click, or an
autosave that arrives after submit, finds no match and gets `409` instead of applying twice.

Events (`submit`, `approve`, `return`, `delete`) are written with `console.log` as `[article] <event> article=<id>
by=<user id> (<role>)` until A's logger exists.

## For Person D

- **Load first, then call.** Load the article (`Article.findById`), answer `404` if it is missing, then call the
  function with `req.session.user` (or whatever A names it). Let the thrown error reach `next(err)`.
- **`approve(article, editor)`** returns `{ article, isFirstPublish }`. The hook for your publish event is marked in
  `approve()` with the comment `// Person D hooks in here`. You can also record the event in your controller from
  the return value.
- **`returnToReporter(article, editor, note)`** needs the note from the request body. An empty or too-long note gives
  `400`, and the article stays `pending`.
- **`deleteArticle(article, user)`** lets an editor delete any article. It does not delete the article's comments
  or `ArticleRead` records yet (see the open question below).
- **Editing while pending.** An editor may change the working copy of a `pending` article with
  `saveWorkingCopy(article, editor, fields)` before approving.
- Never set `status`, `approved` or `publishCount` directly.

## Route middleware (`middleware/articleAccess.js`)

Order on a route: `requireLogin` (A) → `loadArticle` → `requireArticleOwnerOrEditor` → controller.

| Function | What it does |
| --- | --- |
| `loadArticle` | Checks that `:id` is 24 hex characters (`400` if not), loads the article (`404` if missing) and sets `req.article`. Database errors go to `next(err)`. |
| `requireArticleOwnerOrEditor` | Lets an editor, or the reporter who wrote `req.article`, continue. Otherwise `403`, or `401` when nobody is logged in. |
| `getSessionUser(req)` | The logged-in user from the session, or `null`. Controllers pass it to the workflow service. |

Ownership compares `req.article.author` with the session user's `_id`, never with anything in the body, query or
headers. Until A's auth is merged, the session user is assumed to be `req.session.user`; that is read in
`getSessionUser` only.

## Article REST API (`routes/articleApiRoutes.js`, `controllers/articleApiController.js`)

All routes answer JSON and need a logged-in reporter or editor. Routes with `:id` also need the article's author or
an editor. Writes (`POST`, `PATCH`) must be sent as `application/json` (otherwise `415`), so an HTML form on another
site cannot use the reporter's session cookie. Errors reach A's error middleware with `error.status`.

| Route | Calls | Answer |
| --- | --- | --- |
| `POST /api/articles` | `createDraft` | `201` with the article. An editor gets `403`. |
| `GET /api/articles?status=` | `listArticles` | `200 { items: [{ id, title, publicTitle, status, editorNote, updatedAt, publishedAt }] }`. A reporter sees their own, an editor sees all. `status` is optional, one of the four statuses (`400` otherwise). |
| `GET /api/articles/:id` | (none) | `200` with the article. |
| `PATCH /api/articles/:id` | `saveWorkingCopy` | `200 { savedAt }`. The autosave target. |
| `DELETE /api/articles/:id` | `deleteArticle` | `204`. |
| `POST /api/articles/:id/submit` | `submit` | `200` with the article. Also used to resubmit after a return. |
| `POST /api/articles/:id/revise` | `startRevision` | `200` with the article. |

The article in a response: `{ id, status, authorId, authorName, draft: { title, summary, content, imageUrl, category },
approved: { ...same, authorName, publishedAt, updatedAt } or null, editorNote, publishCount, createdAt, updatedAt }`.

**There are no approve or return routes.** Those belong to Person D, whose controllers call `approve()` and
`returnToReporter()` from the workflow service (see "For Person D").

### Mounting (for A)

`server.js` has no place for routers yet, so B did not change it. A adds this line after the session middleware,
and before `express.static` and the error middleware:

```js
app.use(require("./routes/articleApiRoutes"));
```

The router has its own JSON parser with a 200 KB limit, because an article can be up to 50000 characters. The global
`app.use(express.json())` in `server.js` runs first with a 100 KB limit and would answer `413` for a long article.
Either mount this router before the global parsers (the order C's doc also asks for), or raise the global limit.

Until A's login middleware exists, the router uses `requireStaffLogin` from `middleware/articleAccess.js` (401 when
nobody is logged in, 403 for other roles). When A's middleware is merged, replace it in the routes file and delete it.

## Reporter dashboard (`GET /reporter`)

`routes/reporterRoutes.js`, `controllers/reporterController.js`, `views/reporter/dashboard.ejs`,
`public/js/reporter-dashboard.js`, `public/css/reporter.css`. Reporters only (`requireReporterLogin`, the same
stand-in as above). The list is rendered on the server; `?status=` filters it (tabs at the top).

Each row shows the working title (or the public title, or "Untitled"), the category, a status badge with the Hebrew
label (בהכנה, ממתינה לאישור עורך, פורסמה, הוחזרה לתיקונים), the last change, the editor's note for a returned
article, and a note when a published article has a newer version in progress. The actions shown come from the state
machine; the API checks them again.

| Action | Shown when | Does |
| --- | --- | --- |
| Edit | `draft` or `returned` | Link to `/reporter/articles/:id/edit`. |
| View live | the article has a public version | Link to C's page `/articles/:id`. |
| Edit published article | `published` | `POST /api/articles/:id/revise`, then opens the edit page. |
| Delete | never-published `draft` or `returned` | Asks for confirmation, then `DELETE /api/articles/:id`. |
| New article | always | `POST /api/articles`, then opens the edit page. |

The buttons use `fetch` with `application/json`, like C's comments, so the API's cross-site form protection
stays in place. They are disabled until the script has loaded.

## Edit page (`GET /reporter/articles/:id/edit`)

`views/reporter/edit.ejs`, rendered by `renderEditPage` in `controllers/reporterController.js`. Route:
`requireStaffLogin → loadArticle → requireArticleOwnerOrEditor`, so the author and editors can open it; another
reporter gets `403`.

- The form shows the working copy (`draft`): title, summary, article text, image address, and category (a
  `<select>` from `ARTICLE_CATEGORIES`). It is read from the database on every request and sent with
  `Cache-Control: private, no-store`, so the reporter always sees the latest saved version, on any computer.
- When `canEditWorkingCopy` refuses (the author on a `pending` or `published` article, or an editor on anything but
  `pending`), the page still answers `200`. The fields are disabled and a message explains why.
- A `returned` article shows the editor's note at the top. An article with a public version shows "Readers still see
  the published version until an editor approves your changes".
- "Submit for approval" ("Resubmit" when returned) is shown only to the author, in `draft` or `returned`. It is
  disabled until the edit script exists (next step). "Back to dashboard" is shown to reporters only, because
  `/reporter` is reporters only.
- There is no Save button, and the form is never sent natively. Saving is autosave (below).

### Autosave (`public/js/reporter-autosave.js`)

Loaded only when the article can be edited. Each change is sent with `PATCH /api/articles/:id`, containing only
the changed fields, 1.5 seconds after the last keystroke. The status line next to the title shows "Saving…",
"Saved at HH:MM" (browser time) or "Offline – will retry".

- **One save at a time.** Changes made while a save is running are sent right after it.
- **Network failure or 5xx.** The data stays in the page and is retried after 2, 4, 8, then every 15 seconds,
  and at once when the browser comes back online.
- **400.** The server's message is shown ("Not saved: …"). The next change tries again.
- **401, 403, 409.** Autosave stops, the fields are locked, and the user is asked to reload. For example, the
  article was submitted from another tab, or an editor took it.
- **Hiding or closing the page** (`visibilitychange` to hidden, `pagehide`). Pending changes are sent at once with
  `fetch(..., { keepalive: true })`. A body over about 60 KB cannot use keepalive and is sent normally.
- **`beforeunload`** asks "Leave site?" only when changes could not be sent: autosave stopped, or the last save
  failed.
- **No localStorage copy.** The server is the only copy, so the latest text appears on any computer.
- **For D:** editors can use this page to fix a pending article before approving. D's dashboard can link to
  `/reporter/articles/:id/edit`.

**For A:**
- Mount the router next to the API router: `app.use(require("./routes/reporterRoutes"));`.
- After login, send reporters to `/reporter`.
- The view needs EJS with the project's `views` folder as the template root, as C's doc already asks.
- Until A's shared layout exists, the page includes C's temporary partials (`views/public/partials/top` and
  `bottom`) and adds its own stylesheet inside the page. When A's layout arrives, switch the two includes and move
  `/css/reporter.css` into the head. C's files were not changed.
- 401 and 403 reach A's error middleware like the API errors. For this page, redirecting a 401 to the login page
  would be friendlier than an error page.

## Differences from C's doc, and why

- **Working copy is called `draft`, not `pending`.** C never reads it. Note that `draft` (the sub-document) and
  `status: "draft"` are different things: a published article being edited has both.
- **`category` is limited to a fixed list.** C's filter accepts any text, so this needs no change from C. Unknown
  categories simply return an empty feed.
- **`approved.updatedAt` means the latest approval.** There is no separate `lastPublishedAt`, so the date lives in
  one place.

## Needed from others

- **A:** errors thrown by `assertTransition` carry the HTTP code in `error.status`, which Express's default handler
  already reads. A's error middleware should read the same field and send `error.message` for 4xx errors. Roles are
  expected as the strings `"reporter"` and `"editor"`.
- **A:** the workflow service expects the logged-in user as `{ _id, role, name }`, where `name` is the display name
  shown as the byline. If A's session uses other names, the controllers map them before calling the service.
- **A:** a User model registered as `"User"`. If it gets another name, change `ref` in `models/Article.js`. At startup, call
  `useArticleModel(Article)` and make sure the indexes exist before the first request (`await Article.init()`).
- **C (optional):** `approvedOnlyFilter` in `services/publicArticleService.js` duplicates `Article.publicFilter()`.
  To keep one definition, C can replace it with `getArticleModel().publicFilter()`. B has not changed C's file.
- **D:** increase `totalViews` with `$inc`. Use `Article.publicFilter()` wherever "visible to the public" is needed.
- **Open:** who deletes an article's comments and `ArticleRead` records when the article is deleted.
