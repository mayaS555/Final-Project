# Person B - Article model handoff

## Summary

`models/Article.js` (collection `articles`) and `models/articleCategories.js`. Each article holds a public version
(`approved`) and a working copy (`draft`). The field names inside `approved` are exactly the ones C's
`services/publicArticleService.js` already reads, so C's code works with this model unchanged.

Not in this step: the service that moves articles between states, the Article API, the reporter area and the seed.

## Fields

| Field | Type | Meaning |
| --- | --- | --- |
| `author` | ObjectId, `ref: "User"`, required | The reporter who owns the article. |
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

## Differences from C's doc, and why

- **Working copy is called `draft`, not `pending`.** C never reads it. Note that `draft` (the sub-document) and
  `status: "draft"` are different things: a published article being edited has both.
- **`category` is limited to a fixed list.** C's filter accepts any text, so this needs no change from C. Unknown
  categories simply return an empty feed.
- **`approved.updatedAt` means the latest approval.** There is no separate `lastPublishedAt`, so the date lives in
  one place.

## Needed from others

- **A:** a User model registered as `"User"`. If it gets another name, change `ref` in `models/Article.js`. Approval
  needs the user's display name for `approved.authorName`; tell B which field holds it. At startup, call
  `useArticleModel(Article)` and make sure the indexes exist before the first request (`await Article.init()`).
- **C (optional):** `approvedOnlyFilter` in `services/publicArticleService.js` duplicates `Article.publicFilter()`.
  To keep one definition, C can replace it with `getArticleModel().publicFilter()`. B has not changed C's file.
- **D:** increase `totalViews` with `$inc`. Use `Article.publicFilter()` wherever "visible to the public" is needed.
- **Open:** who deletes an article's comments and `ArticleRead` records when the article is deleted.
