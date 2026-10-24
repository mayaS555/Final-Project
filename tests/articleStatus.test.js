// Tests for the article state machine in services/articleStatus.js (owned by B). No database needed.
// Run: node --test tests/

const { describe, test } = require("node:test");
const assert = require("assert");
const {
  ARTICLE_TRANSITIONS,
  canTransition,
  assertTransition,
  canEditWorkingCopy,
  canDelete,
  createHttpError,
} = require("../services/articleStatus");

/**
 * Asserts that a status change is refused by both canTransition and assertTransition.
 * @param {string} from Current status.
 * @param {string} to Requested status.
 * @param {string} role The user's role.
 * @param {number} status Expected error.status (403 or 409).
 * @returns {void}
 * @example expectRejected("draft", "published", "editor", 409);
 */
function expectRejected(from, to, role, status) {
  assert.equal(canTransition(from, to, role), false, `${role}: ${from} -> ${to} should be rejected`);
  assert.throws(() => assertTransition(from, to, role), { status });
}

describe("transitions", () => {
  test("every row of the table is allowed for its own role", () => {
    for (const { from, to, by } of ARTICLE_TRANSITIONS) {
      assert.equal(canTransition(from, to, by), true, `${by}: ${from} -> ${to}`);
      assert.doesNotThrow(() => assertTransition(from, to, by));
    }
  });

  test("every row is refused with 403 for the other role and for no role", () => {
    for (const { from, to, by } of ARTICLE_TRANSITIONS) {
      expectRejected(from, to, by === "editor" ? "reporter" : "editor", 403);
      expectRejected(from, to, undefined, 403);
    }
  });

  test("changes that are not in the table are refused with 409", () => {
    expectRejected("draft", "published", "editor", 409);
    expectRejected("returned", "published", "editor", 409);
    expectRejected("published", "pending", "reporter", 409);
    expectRejected("published", "returned", "editor", 409);
    expectRejected("draft", "returned", "editor", 409);
    expectRejected("draft", "draft", "reporter", 409);
    expectRejected("unknown", "pending", "reporter", 409);
  });

  test("a reporter cannot approve and an editor cannot submit", () => {
    expectRejected("pending", "published", "reporter", 403);
    expectRejected("pending", "returned", "reporter", 403);
    expectRejected("draft", "pending", "editor", 403);
    expectRejected("published", "draft", "editor", 403);
  });

  test("an admin can make every transition", () => {
    for (const { from, to } of ARTICLE_TRANSITIONS) {
      assert.equal(canTransition(from, to, "admin"), true, `admin: ${from} -> ${to}`);
      assert.doesNotThrow(() => assertTransition(from, to, "admin"));
    }
  });

  test("error messages say what went wrong", () => {
    assert.throws(() => assertTransition("pending", "published", "reporter"), {
      message: "Only an editor can approve an article.",
    });
    assert.throws(() => assertTransition("draft", "pending", "editor"), {
      message: "Only a reporter can submit an article.",
    });
    assert.throws(() => assertTransition("draft", "published", "editor"), {
      message: "An article cannot go from draft to published.",
    });
  });
});

describe("canEditWorkingCopy", () => {
  test("the author edits a draft or a returned article", () => {
    assert.equal(canEditWorkingCopy("draft", "reporter", true), true);
    assert.equal(canEditWorkingCopy("returned", "reporter", true), true);
  });

  test("the author cannot edit while pending or published", () => {
    assert.equal(canEditWorkingCopy("pending", "reporter", true), false);
    assert.equal(canEditWorkingCopy("published", "reporter", true), false);
  });

  test("another reporter can never edit", () => {
    for (const status of ["draft", "pending", "returned", "published"]) {
      assert.equal(canEditWorkingCopy(status, "reporter", false), false, status);
    }
  });

  test("an editor edits only while pending", () => {
    assert.equal(canEditWorkingCopy("pending", "editor", false), true);
    assert.equal(canEditWorkingCopy("draft", "editor", false), false);
    assert.equal(canEditWorkingCopy("returned", "editor", false), false);
    assert.equal(canEditWorkingCopy("published", "editor", false), false);
  });

  test("an admin edits their own drafts and any pending article", () => {
    assert.equal(canEditWorkingCopy("draft", "admin", true), true);
    assert.equal(canEditWorkingCopy("returned", "admin", true), true);
    assert.equal(canEditWorkingCopy("pending", "admin", true), true);
    assert.equal(canEditWorkingCopy("pending", "admin", false), true);
    assert.equal(canEditWorkingCopy("draft", "admin", false), false);
    assert.equal(canEditWorkingCopy("returned", "admin", false), false);
    assert.equal(canEditWorkingCopy("published", "admin", true), false);
  });

  test("an unknown role cannot edit", () => {
    assert.equal(canEditWorkingCopy("draft", "guest", true), false);
    assert.equal(canEditWorkingCopy("draft", undefined, true), false);
  });
});

describe("canDelete", () => {
  const publishedAt = new Date();

  test("the author deletes a never-published draft or returned article", () => {
    assert.equal(canDelete({ status: "draft" }, "reporter", true), true);
    assert.equal(canDelete({ status: "returned" }, "reporter", true), true);
  });

  test("the author cannot delete while pending, or once it was published", () => {
    assert.equal(canDelete({ status: "pending" }, "reporter", true), false);
    assert.equal(canDelete({ status: "published", approved: { publishedAt } }, "reporter", true), false);
    assert.equal(canDelete({ status: "draft", approved: { publishedAt } }, "reporter", true), false);
  });

  test("another reporter cannot delete", () => {
    assert.equal(canDelete({ status: "draft" }, "reporter", false), false);
  });

  test("an editor deletes any article", () => {
    for (const status of ["draft", "pending", "returned", "published"]) {
      assert.equal(canDelete({ status, approved: { publishedAt } }, "editor", false), true, status);
    }
  });

  test("an admin deletes any article", () => {
    for (const status of ["draft", "pending", "returned", "published"]) {
      assert.equal(canDelete({ status, approved: { publishedAt } }, "admin", false), true, status);
    }
  });

  test("an unknown role cannot delete", () => {
    assert.equal(canDelete({ status: "draft" }, "guest", true), false);
  });
});

test("createHttpError sets the status and the message", () => {
  const error = createHttpError(409, "Conflict here.");
  assert.ok(error instanceof Error);
  assert.equal(error.status, 409);
  assert.equal(error.message, "Conflict here.");
});
