// MongoDB connection for the tests that need a database (owned by B).
// Those tests run only when MONGODB_TEST_URI is set, and only against a database whose name contains
// "test", because they delete all articles. Without the variable they are skipped, not failed.

const mongoose = require("mongoose");
const Article = require("../models/Article");

const TEST_DATABASE_URI = process.env.MONGODB_TEST_URI;
// Passed to describe({ skip }): false runs the tests, a string skips them with this reason.
const skipWithoutDatabase = TEST_DATABASE_URI ? false : "MONGODB_TEST_URI is not set";

/**
 * Connects to the test database, builds the Article indexes and removes all articles.
 * @returns {Promise<void>} Resolves when the database is ready.
 * @throws {Error} When the database name does not contain "test" (nothing is deleted then).
 * @example before(connectTestDatabase);
 */
async function connectTestDatabase() {
  await mongoose.connect(TEST_DATABASE_URI);
  const name = mongoose.connection.name;
  if (!name.includes("test")) {
    await mongoose.disconnect();
    throw new Error(`Refusing to run: database "${name}" does not contain "test".`);
  }
  await Article.init();
  await Article.deleteMany({});
}

/**
 * Removes the articles the tests created and closes the connection.
 * @returns {Promise<void>} Resolves when disconnected.
 * @example after(disconnectTestDatabase);
 */
async function disconnectTestDatabase() {
  await Article.deleteMany({});
  await mongoose.disconnect();
}

module.exports = { skipWithoutDatabase, connectTestDatabase, disconnectTestDatabase };
