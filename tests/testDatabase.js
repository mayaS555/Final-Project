// MongoDB connection for the tests that need a database (owned by B).
// Those tests run only when MONGODB_TEST_URI is set, and only when its database name contains "test".
// node --test runs each test file in its own process, at the same time, so every process uses its own
// database ("<name>-<process id>") and empties it at the end. Without the variable the tests are skipped.
// ponytail: the empty databases stay (dropDatabase hung while other test processes were running). Remove them with
//   mongosh <server> --eval 'db.getMongo().getDBNames().filter((n) => /-test-\d+$/.test(n)).forEach((n) => db.getSiblingDB(n).dropDatabase())'

const mongoose = require("mongoose");
const Article = require("../models/Article");

const TEST_DATABASE_URI = process.env.MONGODB_TEST_URI;
// Passed to describe({ skip }): false runs the tests, a string skips them with this reason.
const skipWithoutDatabase = TEST_DATABASE_URI ? false : "MONGODB_TEST_URI is not set";

/**
 * Connects to this process's own test database and builds the Article indexes.
 * @returns {Promise<void>} Resolves when the database is ready.
 * @throws {Error} When the database name in MONGODB_TEST_URI does not contain "test" (nothing is touched then).
 * @example before(connectTestDatabase);
 */
async function connectTestDatabase() {
  const baseName = new URL(TEST_DATABASE_URI).pathname.slice(1);
  if (!baseName.includes("test")) {
    throw new Error(`Refusing to run: database "${baseName}" in MONGODB_TEST_URI does not contain "test".`);
  }
  await mongoose.connect(TEST_DATABASE_URI, { dbName: `${baseName}-${process.pid}` });
  await Article.init();
}

/**
 * Removes the articles this process created and closes the connection.
 * @returns {Promise<void>} Resolves when disconnected.
 * @example after(disconnectTestDatabase);
 */
async function disconnectTestDatabase() {
  await Article.deleteMany({});
  await mongoose.disconnect();
}

module.exports = { skipWithoutDatabase, connectTestDatabase, disconnectTestDatabase };
