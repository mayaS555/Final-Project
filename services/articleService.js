// Article workflow (owned by B): the ONLY place that changes an article's status or its public (approved) fields.
// Called by B's reporter controllers and D's editor controllers, which never set status or approved themselves.
// Every check uses services/articleStatus.js. Errors are thrown with error.status (400, 403, 409); database errors
// are rethrown. `user` is the logged-in user from A's session: { _id, role: "reporter" | "editor", name }.

const Article = require("../models/Article");
const logger = require("./logger");
const { toSafeImageUrl } = require("./publicArticleService");
const { assertTransition, canEditWorkingCopy, canDelete, createHttpError } = require("./articleStatus");

// The working-copy fields a request may change. Any other key is rejected.
const WORKING_COPY_FIELDS = ["title", "summary", "content", "imageUrl", "category"];
// The working copy must have these before it can be reviewed or published.
const REQUIRED_FOR_REVIEW = ["title", "content", "category"];
const MAX_EDITOR_NOTE_LENGTH = 1000;

/**
 * Writes an article event to the server log.
 * @param {string} event What happened ("submit", "approve", "return", "delete").
 * @param {Object} article The article the event is about.
 * @param {Object} user The acting user.
 * @returns {void}
 * @example logArticleEvent("approve", article, editor);
 */
function logArticleEvent(event, article, user) {
  logger.logArticleEvent(event, article._id, user._id, user.role);
}

/**
 * Tells whether the user wrote the article.
 * @param {Object} article The article document.
 * @param {Object} user The acting user.
 * @returns {boolean} true when article.author is the user's id.
 * @example if (isAuthor(article, req.session.user)) { ... }
 */
function isAuthor(article, user) {
  return String(article.author) === String(user._id);
}

/**
 * Throws 403 unless the user wrote the article. Used for the reporter's status changes.
 * @param {Object} article The article document.
 * @param {Object} user The acting user.
 * @returns {void}
 * @throws {Error} error.status 403 when the user is not the author.
 * @example assertAuthor(article, user);
 */
function assertAuthor(article, user) {
  if (!isAuthor(article, user)) {
    throw createHttpError(403, "You can only change your own articles.");
  }
}

/**
 * Throws 400 when a required working-copy field is empty.
 * @param {Object} workingCopy The article's draft sub-document.
 * @returns {void}
 * @throws {Error} error.status 400 naming the empty fields.
 * @example assertReadyForReview(article.draft);
 */
function assertReadyForReview(workingCopy) {
  const missing = REQUIRED_FOR_REVIEW.filter((name) => !workingCopy[name]);
  if (missing.length > 0) {
    throw createHttpError(400, `Please fill in: ${missing.join(", ")}.`);
  }
}

/**
 * Checks the fields of a save request and turns them into a MongoDB $set on the working copy.
 * @param {*} fields The request body. Only keys from WORKING_COPY_FIELDS are allowed; each must be text.
 * @returns {Object} The $set, for example { "draft.title": "Storm" }. Empty when no field was sent.
 * @throws {Error} error.status 400 for a non-object body, an unknown key, a non-text value or a bad image URL.
 * @example const changes = toWorkingCopyUpdate(req.body);
 */
function toWorkingCopyUpdate(fields) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    throw createHttpError(400, "The request body must be a JSON object.");
  }
  const unknownKeys = Object.keys(fields).filter((key) => !WORKING_COPY_FIELDS.includes(key));
  if (unknownKeys.length > 0) {
    throw createHttpError(400, `These fields cannot be changed here: ${unknownKeys.join(", ")}.`);
  }

  const changes = {};
  for (const [name, value] of Object.entries(fields)) {
    if (typeof value !== "string") {
      throw createHttpError(400, `${name} must be text.`);
    }
    changes[`draft.${name}`] = value.replace(/\r\n/g, "\n").trim();
  }
  // Same rule as the public site, so a saved image is never silently dropped when it is shown.
  const imageUrl = changes["draft.imageUrl"];
  if (imageUrl && !toSafeImageUrl(imageUrl)) {
    throw createHttpError(400, "imageUrl must be an http(s) address or a path starting with /.");
  }
  return changes;
}

/**
 * Saves a change only if the article still has the status it had when it was loaded, so two fast
 * clicks (or an autosave that arrives after submit) cannot apply twice or change a locked article.
 * @param {Object} article The article document the caller loaded.
 * @param {Object} update A MongoDB update ({ $set, $inc }).
 * @returns {Promise<Object>} The updated article document.
 * @throws {Error} error.status 409 when the status changed meanwhile, 400 when the model rejects a value
 *   (too long, unknown category). Other database errors are rethrown.
 * @example const updated = await updateIfStatusUnchanged(article, { $set: { status: "pending" } });
 */
async function updateIfStatusUnchanged(article, update) {
  let updated;
  try {
    updated = await Article.findOneAndUpdate({ _id: article._id, status: article.status }, update, {
      returnDocument: "after",
      runValidators: true,
    });
  } catch (error) {
    if (error.name === "ValidationError") {
      const field = Object.values(error.errors)[0].path.replace(/^draft\./, "");
      throw createHttpError(400, `Invalid value for ${field}.`);
    }
    throw error;
  }
  if (!updated) {
    throw createHttpError(409, "The article was changed meanwhile. Reload the page and try again.");
  }
  return updated;
}

/**
 * Creates a new, empty draft owned by a reporter.
 * @param {Object} user The logged-in reporter ({ _id, role, name }).
 * @returns {Promise<Object>} The new article document (status "draft").
 * @throws {Error} error.status 403 when the user is not a reporter.
 * @example const article = await createDraft(req.session.user);
 */
async function createDraft(user) {
  if (user.role !== "reporter") {
    throw createHttpError(403, "Only a reporter can create an article.");
  }
  return Article.create({ author: user._id, authorName: user.name });
}

/**
 * Saves changes to the working copy (manual save and autosave). The public version is not touched.
 * @param {Object} article The article document.
 * @param {Object} user The acting user.
 * @param {Object} fields The request body: any of title, summary, content, imageUrl, category.
 * @returns {Promise<Object>} The updated article document (unchanged when no field was sent).
 * @throws {Error} error.status 400 invalid fields, 403 not allowed to edit in this status or not the author,
 *   409 status changed meanwhile.
 * @example const article = await saveWorkingCopy(article, req.session.user, req.body);
 */
async function saveWorkingCopy(article, user, fields) {
  const changes = toWorkingCopyUpdate(fields);
  if (!canEditWorkingCopy(article.status, user.role, isAuthor(article, user))) {
    throw createHttpError(403, `You cannot edit this article while it is ${article.status}.`);
  }
  if (Object.keys(changes).length === 0) {
    return article;
  }
  return updateIfStatusUnchanged(article, { $set: changes });
}

/**
 * Sends the working copy to the editors: draft or returned -> pending. Clears the editor's note.
 * @param {Object} article The article document.
 * @param {Object} user The logged-in reporter.
 * @returns {Promise<Object>} The updated article document (status "pending").
 * @throws {Error} error.status 400 title, content or category empty, 403 not a reporter or not the author,
 *   409 wrong status or changed meanwhile.
 * @example const article = await submit(article, req.session.user);
 */
async function submit(article, user) {
  assertTransition(article.status, "pending", user.role);
  assertAuthor(article, user);
  assertReadyForReview(article.draft);
  const updated = await updateIfStatusUnchanged(article, { $set: { status: "pending", editorNote: "" } });
  logArticleEvent("submit", updated, user);
  return updated;
}

/**
 * Publishes the working copy: pending -> published. Copies the working copy into the public fields,
 * sets approved.publishedAt on the first publish and approved.updatedAt every time, and adds 1 to publishCount.
 * @param {Object} article The article document.
 * @param {Object} editor The logged-in editor.
 * @returns {Promise<{ article: Object, isFirstPublish: boolean }>} The published article, and whether this
 *   was its first publish (for D's publish event).
 * @throws {Error} error.status 400 working copy incomplete, 403 not an editor, 409 wrong status or changed meanwhile.
 * @example Used by D: const { article, isFirstPublish } = await approve(article, req.session.user);
 */
async function approve(article, editor) {
  assertTransition(article.status, "published", editor.role);
  assertReadyForReview(article.draft);

  const now = new Date();
  const isFirstPublish = !(article.approved && article.approved.publishedAt);
  const { title, summary, content, imageUrl, category } = article.draft;
  const updated = await updateIfStatusUnchanged(article, {
    $set: {
      status: "published",
      editorNote: "",
      approved: {
        title,
        summary,
        content,
        imageUrl,
        category,
        authorName: article.authorName,
        publishedAt: isFirstPublish ? now : article.approved.publishedAt,
        updatedAt: now,
      },
    },
    $inc: { publishCount: 1 },
  });
  logArticleEvent("approve", updated, editor);
  // Person D hooks in here: record the publish event (updated._id, isFirstPublish, now).
  return { article: updated, isFirstPublish };
}

/**
 * Sends the working copy back to its reporter: pending -> returned, with the editor's reason.
 * @param {Object} article The article document.
 * @param {Object} editor The logged-in editor.
 * @param {*} note The editor's reason (required, trimmed, at most 1000 characters).
 * @returns {Promise<Object>} The updated article document (status "returned").
 * @throws {Error} error.status 400 empty or too long note, 403 not an editor, 409 wrong status or changed meanwhile.
 * @example Used by D: const article = await returnToReporter(article, req.session.user, req.body.note);
 */
async function returnToReporter(article, editor, note) {
  assertTransition(article.status, "returned", editor.role);
  const editorNote = typeof note === "string" ? note.replace(/\r\n/g, "\n").trim() : "";
  if (editorNote.length === 0) {
    throw createHttpError(400, "Please write why the article is returned.");
  }
  if (editorNote.length > MAX_EDITOR_NOTE_LENGTH) {
    throw createHttpError(400, `The note must be at most ${MAX_EDITOR_NOTE_LENGTH} characters.`);
  }
  const updated = await updateIfStatusUnchanged(article, { $set: { status: "returned", editorNote } });
  logArticleEvent("return", updated, editor);
  return updated;
}

/**
 * Opens a published article for changes: published -> draft. Copies the public version into the working
 * copy so the reporter starts from what readers see. The public version stays online and unchanged.
 * @param {Object} article The article document.
 * @param {Object} user The logged-in reporter.
 * @returns {Promise<Object>} The updated article document (status "draft").
 * @throws {Error} error.status 403 not a reporter or not the author, 409 wrong status or changed meanwhile.
 * @example const article = await startRevision(article, req.session.user);
 */
async function startRevision(article, user) {
  assertTransition(article.status, "draft", user.role);
  assertAuthor(article, user);
  const { title, summary, content, imageUrl, category } = article.approved;
  return updateIfStatusUnchanged(article, {
    $set: { status: "draft", draft: { title, summary, content, imageUrl, category } },
  });
}

/**
 * Deletes an article.
 * @param {Object} article The article document.
 * @param {Object} user The acting user.
 * @returns {Promise<void>} Resolves when the article is deleted.
 * @throws {Error} error.status 403 when canDelete refuses, 409 when the status changed meanwhile.
 * @example Used by D and the reporter dashboard: await deleteArticle(article, req.session.user);
 */
async function deleteArticle(article, user) {
  if (!canDelete(article, user.role, isAuthor(article, user))) {
    throw createHttpError(403, "You cannot delete this article.");
  }
  // Open question (B/C/D): the article's comments and read history are not deleted here.
  const result = await Article.deleteOne({ _id: article._id, status: article.status });
  if (result.deletedCount !== 1) {
    throw createHttpError(409, "The article was changed meanwhile. Reload the page and try again.");
  }
  logArticleEvent("delete", article, user);
}

/**
 * Lists articles for the staff dashboards, last changed first: a reporter sees only their own, an editor sees all.
 * Only the fields of a list row are read. Uses the { author, updatedAt } and { status, updatedAt } indexes.
 * @param {Object} user The logged-in user.
 * @param {string} [status] Optional status filter; must already be one of the article statuses.
 * @returns {Promise<Object[]>} Lean articles with the title and category of draft and approved, approved.publishedAt,
 *   status, editorNote and updatedAt.
 * @throws {Error} error.status 403 for a role other than reporter or editor.
 * @example const rows = await listArticles(req.session.user, "pending");
 */
async function listArticles(user, status) {
  let filter;
  if (user.role === "reporter") {
    filter = { author: user._id };
  } else if (user.role === "editor") {
    filter = {};
  } else {
    throw createHttpError(403, "Only reporters and editors can list articles.");
  }
  if (status) {
    filter.status = status;
  }
  // ponytail: no paging; an editor listing every status sorts in memory. Add skip/limit when the list grows.
  return Article.find(filter)
    .select({
      "draft.title": 1,
      "draft.category": 1,
      "approved.title": 1,
      "approved.category": 1,
      "approved.publishedAt": 1,
      status: 1,
      editorNote: 1,
      updatedAt: 1,
    })
    .sort({ updatedAt: -1 })
    .lean();
}

module.exports = {
  REQUIRED_FOR_REVIEW,
  listArticles,
  createDraft,
  saveWorkingCopy,
  submit,
  approve,
  returnToReporter,
  startRevision,
  deleteArticle,
};
