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

// Who may change the working copy (article.draft) in which status.
// A reporter edits only their own article, and only while it is a draft or was returned.
// An editor edits while reviewing (pending), for example to fix a typo before approving.
// TODO(B): person-b-plan.md says editors may edit the working copy in ANY status; this allows only pending.
// Decide with D (editing a draft the reporter is typing in makes the two autosaves overwrite each other).
const EDITABLE_STATUSES = {
  reporter: ["draft", "returned"],
  editor: ["pending"],
};

// A reporter may delete only their own article that was never public and is not under review.
// TODO(B): person-b-plan.md allows reporters to delete only never-published drafts; this also allows returned.
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
 * @param {string} role The user's role ("reporter" or "editor").
 * @returns {boolean} true only for a row of ARTICLE_TRANSITIONS done by that role.
 * @example canTransition("draft", "pending", "reporter") // true
 */
function canTransition(fromStatus, toStatus, role) {
  const transition = findTransition(fromStatus, toStatus);
  return Boolean(transition) && transition.by === role;
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
 * @param {string} role The user's role ("reporter" or "editor").
 * @returns {void} Returns nothing when the change is allowed.
 * @throws {Error} error.status 403 when the change exists but belongs to another role,
 *   409 when the change does not exist from this status.
 * @example
 *   assertTransition(article.status, "published", req.user.role); // inside try, or let Express 5 pass it to next(err)
 */
function assertTransition(fromStatus, toStatus, role) {
  const transition = findTransition(fromStatus, toStatus);
  if (!transition) {
    throw createHttpError(409, `An article cannot go from ${fromStatus} to ${toStatus}.`);
  }
  if (transition.by !== role) {
    throw createHttpError(403, `Only ${transition.by === "editor" ? "an editor" : "a reporter"} can ${transition.action} an article.`);
  }
}

/**
 * Tells whether a user may change the article's working copy (article.draft), including autosave.
 * @param {string} status Current article status.
 * @param {string} role The user's role ("reporter" or "editor").
 * @param {boolean} isOwner true when the user is the article's author. Ignored for editors.
 * @returns {boolean} Reporter: own article in draft or returned. Editor: any article in pending.
 * @example canEditWorkingCopy("pending", "reporter", true) // false: locked while under review
 */
function canEditWorkingCopy(status, role, isOwner) {
  if (role === "reporter" && !isOwner) {
    return false;
  }
  const statuses = EDITABLE_STATUSES[role];
  return Boolean(statuses) && statuses.includes(status);
}

/**
 * Tells whether a user may delete an article.
 * @param {{ status: string, approved?: Object }} article The article (status and approved are read).
 * @param {string} role The user's role ("reporter" or "editor").
 * @param {boolean} isOwner true when the user is the article's author.
 * @returns {boolean} Editor: always. Reporter: own article in draft or returned that was never published.
 * @example canDelete({ status: "draft" }, "reporter", true) // true
 */
function canDelete(article, role, isOwner) {
  if (role === "editor") {
    return true;
  }
  const neverPublished = !(article.approved && article.approved.publishedAt);
  return role === "reporter" && isOwner && neverPublished && REPORTER_DELETABLE_STATUSES.includes(article.status);
}

module.exports = {
  ARTICLE_TRANSITIONS,
  canTransition,
  assertTransition,
  canEditWorkingCopy,
  canDelete,
  createHttpError,
};
