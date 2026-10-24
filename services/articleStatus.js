// Article status state machine (owned by B). Pure rules: no Express, no database.
// Used by B's Article API and reporter area, and by D's editor actions, to decide on the server
// which status changes, edits and deletes are allowed. Ownership (isOwner) is decided by the caller.

// Every allowed status change. Anything not listed here is rejected.
const ARTICLE_TRANSITIONS = [
  { from: "draft", to: "pending", by: "reporter", action: "submit" },
  { from: "returned", to: "pending", by: "reporter", action: "resubmit" },
  { from: "pending", to: "published", by: "editor", action: "approve" },
  { from: "pending", to: "returned", by: "editor", action: "return" },
  { from: "published", to: "draft", by: "reporter", action: "startRevision" },
];

// The admin role combines the reporter and editor capabilities.
const REPORTER_EDITABLE_STATUSES = ["draft", "returned"];

/**
 * Tells whether a role has the editor capabilities. Admins have all of them.
 * @param {string} role The user's role.
 * @returns {boolean} true for "editor" and "admin".
 * @example hasEditorRole("admin") // true
 */
function hasEditorRole(role) {
  return role === "editor" || role === "admin";
}

/**
 * Tells whether a role has the reporter capabilities. Admins have all of them.
 * @param {string} role The user's role.
 * @returns {boolean} true for "reporter" and "admin".
 * @example hasReporterRole("admin") // true
 */
function hasReporterRole(role) {
  return role === "reporter" || role === "admin";
}

// A reporter may delete only their own article that was never public and is not under review.
const REPORTER_DELETABLE_STATUSES = ["draft", "returned"];

/**
 * Finds the table row for a status change, whatever the role.
 * @param {string} fromStatus Current status.
 * @param {string} toStatus Requested status.
 * @returns {Object|undefined} The row from ARTICLE_TRANSITIONS, or undefined when the change does not exist.
 * @example findTransition("pending", "returned") // { from: "pending", to: "returned", by: "editor", action: "return" }
 */
function findTransition(fromStatus, toStatus) {
  return ARTICLE_TRANSITIONS.find((transition) => transition.from === fromStatus && transition.to === toStatus);
}

/**
 * Tells whether a role may move an article from one status to another.
 * @param {string} fromStatus Current status.
 * @param {string} toStatus Requested status.
 * @param {string} role The user's role ("reporter", "editor" or "admin").
 * @returns {boolean} true for the row's own role; an admin may make every row.
 * @example canTransition("draft", "pending", "reporter") // true
 */
function canTransition(fromStatus, toStatus, role) {
  const transition = findTransition(fromStatus, toStatus);
  return Boolean(transition) && (role === "admin" || transition.by === role);
}

/**
 * Builds an Error carrying an HTTP status, for the error middleware (it reads error.status).
 * @param {number} status HTTP status code.
 * @param {string} message Message that is safe to show to the user.
 * @returns {Error} The error, with error.status set.
 * @example throw createHttpError(409, "Not allowed.");
 */
function createHttpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/**
 * Throws when a role may not make a status change.
 * @param {string} fromStatus Current status.
 * @param {string} toStatus Requested status.
 * @param {string} role The user's role ("reporter", "editor" or "admin").
 * @returns {void} Returns nothing when the change is allowed.
 * @throws {Error} error.status 403 when the change exists but belongs to another role,
 *   409 when the change does not exist from this status. Admins may make every change.
 * @example
 *   assertTransition(article.status, "published", req.user.role); // inside try, or let Express 5 pass it to next(err)
 */
function assertTransition(fromStatus, toStatus, role) {
  const transition = findTransition(fromStatus, toStatus);
  if (!transition) {
    throw createHttpError(409, `An article cannot go from ${fromStatus} to ${toStatus}.`);
  }
  if (role !== "admin" && transition.by !== role) {
    throw createHttpError(403, `Only ${transition.by === "editor" ? "an editor" : "a reporter"} can ${transition.action} an article.`);
  }
}

/**
 * Tells whether a user may change the article's working copy (article.draft), including autosave.
 * @param {string} status Current article status.
 * @param {string} role The user's role ("reporter", "editor" or "admin").
 * @param {boolean} isOwner true when the user is the article's author.
 * @returns {boolean} Reporter: own article in draft or returned. Editor: any article in pending.
 *   Admin: either set of rules.
 * @example canEditWorkingCopy("pending", "reporter", true) // false: locked while under review
 */
function canEditWorkingCopy(status, role, isOwner) {
  if (hasEditorRole(role) && status === "pending") {
    return true;
  }
  return hasReporterRole(role) && isOwner && REPORTER_EDITABLE_STATUSES.includes(status);
}

/**
 * Tells whether a user may delete an article.
 * @param {{ status: string, approved?: Object }} article The article (status and approved are read).
 * @param {string} role The user's role ("reporter", "editor" or "admin").
 * @param {boolean} isOwner true when the user is the article's author.
 * @returns {boolean} Editor or admin: always. Reporter: own article in draft or returned that was never published.
 * @example canDelete({ status: "draft" }, "reporter", true) // true
 */
function canDelete(article, role, isOwner) {
  if (hasEditorRole(role)) {
    return true;
  }
  const neverPublished = !(article.approved && article.approved.publishedAt);
  return role === "reporter" && isOwner && neverPublished && REPORTER_DELETABLE_STATUSES.includes(article.status);
}

module.exports = {
  ARTICLE_TRANSITIONS,
  hasEditorRole,
  hasReporterRole,
  canTransition,
  assertTransition,
  canEditWorkingCopy,
  canDelete,
  createHttpError,
};
