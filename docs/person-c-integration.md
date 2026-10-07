# Person C - public site integration notes

Status: milestone 1 (feed, JSON feed, article page). Search, filters, sort, infinite scroll,
comments, viewed state and view counting are not implemented yet.

Facts below describe code that exists in this branch. Items under "Assumptions" are proposals
by C and are not agreed with A, B or D.

## Request flow

```
GET /                     -> publicController.renderHome  -+
GET /api/public/articles  -> publicController.getFeed     -+-> publicArticleService.getPublishedArticles({ page })
GET /articles/:id         -> publicController.renderArticle ---> publicArticleService.getPublishedArticleById(id)
```

The controller validates input and renders EJS or JSON. The service is the only file that knows
the Article field names and builds the MongoDB queries. The HTML feed and the JSON feed call the
same service function with the same validation.

## Routes

| Route | Result |
| --- | --- |
| `GET /` | EJS feed page, first 20 approved articles. Optional `?page=N`, plain links for newer/older pages. |
| `GET /api/public/articles?page=N` | `{ "items": [...], "page": N, "hasMore": true }`. `page` defaults to 1. |
| `GET /articles/:id` | EJS article page with the full content in the initial HTML. |

Feed item fields: `id`, `title`, `summary`, `imageUrl` (or `null`), `category`, `authorName`,
`publishedAt` (ISO string). The article page also uses `content` and `updatedAt`.

Errors: `page` must be a whole number from 1 to 1000, otherwise HTTP 400 (`{ "error": "..." }` for the API,
an HTML message page for `/`). An unknown, malformed, draft-only or unapproved article id gives HTTP 404.
Unexpected failures give HTTP 500 with a generic message; details are only logged on the server.

Pages are 20 articles. The service fetches 21 rows to compute `hasMore`. Ordering is
`approved.publishedAt` descending, then `_id` descending, so equal dates keep a stable order.

## Public content rule

Public code reads only the approved version of an article. An article is public when
`approved.publishedAt` exists. `status` is not used, so an article with a pending update keeps
showing its last approved version, and a draft with no approved version is never visible.
Content is plain text: it is escaped by EJS, blank lines become paragraphs, single line breaks are kept by CSS.
Image URLs must be absolute http(s) or site-relative; anything else is dropped.

## Assumptions (not agreed)

- B's Article model can expose the approved version as `approved: { title, summary, content, category, imageUrl, authorName, publishedAt, updatedAt }`
  next to a separate `pending` revision. Field names live only in `services/publicArticleService.js`.
- Proposed index for B's schema: `{ "approved.publishedAt": -1, _id: -1 }`. More indexes (category, popularity, search) come with later milestones.
- Article body is plain text, not HTML.
- Feed pagination uses page/skip/limit.

## Integration points still open

- A: mount `routes/publicRoutes.js` before `express.static` (otherwise `public/index.html` answers `GET /`),
  set the EJS view engine and the `views` folder, and call `useArticleModel(Article)` from
  `services/publicArticleService.js` once at startup with B's model. The views in `views/public/partials/` are
  temporary and should move to A's shared partials. A's central error handler can replace the try/catch in the controller.
- B: confirm or replace the approved/pending field names above, and add the proposed index.
- D: `recordArticleView(articleId)` is not called yet. The call site is marked in `controllers/publicController.js`.

## Development setup (not part of the production run)

Files in `dev/` are development-only: a fixture model (`dev_public_articles` collection), a server that mounts only the
public module, a seed, and tests. The dev connection selects the database `daily_web_dev_public` regardless of the URI.
Before deleting anything, the seed checks that the model is on an open connection to that database and uses the
`dev_public_articles` collection, and throws without deleting otherwise. The seed deletes all documents in that collection.

1. Put `DEV_MONGODB_URI=<your MongoDB connection string>` in the local `.env` (see `dev/env.example`). Do not commit it.
2. `npm ci`
3. `node dev/seed-public.js` (33 approved articles, one with a different pending revision, one draft-only)
4. `node dev/public-server.js` and open http://localhost:3100
5. `node --test "dev/tests/*.test.js"` (`publicDb.test.js` reseeds the dev collection)

`publicNoDb.test.js` runs without MongoDB. `publicDb.test.js` is skipped, and reports so, when `DEV_MONGODB_URI` is not set.
