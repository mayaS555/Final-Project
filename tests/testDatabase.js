// MongoDB connection for the tests that need a database (owned by B).
// Those tests run only when MONGODB_TEST_URI is set, and only when its database name contains "test".
// node --test runs each test file in its own process, at the same time, so every process uses its own
// database ("<name>-<process id>") and drops it at the end. Without the variable the tests are skipped.

const mongoose = require("mongoose");
const Article = require("../models/Article");

const TEST_DATABASE_URI = process.env.MONGODB_TEST_URI;
// Passed to describe({ skip }): false runs the tests, a string skips them with this reason.
const skipWithoutDatabase = TEST_DATABASE_URI ? false : "MONGODB_TEST_URI is not set";

/**
 * Connects to this process's own test database and builds the Article indexes.
 * @returns {Promise<void>} Resolves when the database is ready.
 * @throws {Error} When the database name in MONGODB_TEST_URI does not contain "test" (nothing is touched then),
 *   or when no MongoDB server answers within a few seconds.
 * @example before(connectTestDatabase);
 */
async function connectTestDatabase() {
  const url = new URL(TEST_DATABASE_URI);
  const baseName = url.pathname.slice(1);
  if (!baseName.includes("test")) {
    throw new Error(`Refusing to run: database "${baseName}" in MONGODB_TEST_URI does not contain "test".`);
  }
  try {
    // Fail after 3 seconds instead of waiting for the test timeout when no server is running.
    await mongoose.connect(TEST_DATABASE_URI, { dbName: `${baseName}-${process.pid}`, serverSelectionTimeoutMS: 3000 });
  } catch (error) {
    // url.host never contains the user name or password.
    throw new Error(`Cannot reach MongoDB at ${url.host}. Start mongod, or unset MONGODB_TEST_URI to skip these tests.`);
  }
  await Article.init();
}

/**
 * Drops this process's test database and closes the connection. Does nothing when connectTestDatabase refused.
 * @returns {Promise<void>} Resolves when disconnected.
 * @example after(disconnectTestDatabase);
 */
async function disconnectTestDatabase() {
  if (mongoose.connection.readyState !== mongoose.ConnectionStates.connected) {
    return;
  }
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}

module.exports = { skipWithoutDatabase, connectTestDatabase, disconnectTestDatabase };
