// Self-check for the article state machine in services/articleStatus.js (owned by B).
// Run: node scripts/check-article-status.js
// Prints "article status checks passed" or stops at the first failed assertion.

const assert = require("assert");
const {
  ARTICLE_TRANSITIONS,
  canTransition,
  assertTransition,
  canEditWorkingCopy,
  canDelete,
} = require("../services/articleStatus");

/**
 * Asserts that assertTransition throws with the expected HTTP status.
 * @param {string} from Current status.
 * @param {string} to Requested status.
 * @param {string} role The user's role.
 * @param {number} status Expected error.status (403 or 409).
 * @returns {void}
 * @example expectRejected("draft", "published", "editor", 409);
 */
function expectRejected(from, to, role, status) {
  assert.equal(canTransition(from, to, role), false, `${role}: ${from} -> ${to} should be rejected`);
  assert.throws(() => assertTransition(from, to, role), (error) => error.status === status);
}

// Every row of the table is allowed for its own role and refused (403) for the other role.
for (const { from, to, by } of ARTICLE_TRANSITIONS) {
  assert.equal(canTransition(from, to, by), true, `${by}: ${from} -> ${to} should be allowed`);
  assert.doesNotThrow(() => assertTransition(from, to, by));
  expectRejected(from, to, by === "editor" ? "reporter" : "editor", 403);
}

// Changes that do not exist.
expectRejected("draft", "published", "editor", 409);
expectRejected("returned", "published", "editor", 409);
expectRejected("published", "pending", "reporter", 409);
expectRejected("draft", "draft", "reporter", 409);
expectRejected("unknown", "pending", "reporter", 409);

// Wrong role: a reporter approving, an editor submitting.
expectRejected("pending", "published", "reporter", 403);
expectRejected("draft", "pending", "editor", 403);
expectRejected("pending", "published", undefined, 403);

// Working copy.
assert.equal(canEditWorkingCopy("draft", "reporter", true), true);
assert.equal(canEditWorkingCopy("returned", "reporter", true), true);
assert.equal(canEditWorkingCopy("draft", "reporter", false), false);
assert.equal(canEditWorkingCopy("pending", "reporter", true), false);
assert.equal(canEditWorkingCopy("published", "reporter", true), false);
assert.equal(canEditWorkingCopy("pending", "editor", false), true);
assert.equal(canEditWorkingCopy("draft", "editor", false), false);
assert.equal(canEditWorkingCopy("draft", "guest", true), false);

// Delete.
const publishedAt = new Date();
assert.equal(canDelete({ status: "draft" }, "reporter", true), true);
assert.equal(canDelete({ status: "returned" }, "reporter", true), true);
assert.equal(canDelete({ status: "draft" }, "reporter", false), false);
assert.equal(canDelete({ status: "pending" }, "reporter", true), false);
assert.equal(canDelete({ status: "draft", approved: { publishedAt } }, "reporter", true), false);
assert.equal(canDelete({ status: "published", approved: { publishedAt } }, "editor", false), true);
assert.equal(canDelete({ status: "draft" }, "guest", true), false);

console.log("article status checks passed");
