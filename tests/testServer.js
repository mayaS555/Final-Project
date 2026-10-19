// A small Express app for the HTTP tests (owned by B). It stands in for A's server: EJS with the project's views
// folder (as C's doc asks A to set it up), a fake session holding the user named in the X-Test-User header
// (test code only), and a JSON error handler in place of A's error middleware.

const path = require("path");
const express = require("express");

/**
 * Starts a test app with the given routers on a free port.
 * @param {Function[]} routers The routers to mount, for example [require("../routes/reporterRoutes")].
 * @param {Object} users The test users by name; X-Test-User: <name> logs that user in.
 * @returns {Promise<{ baseUrl: string, stop: Function }>} The address, and stop() which resolves when closed.
 * @example const testServer = await startTestServer([reporterRoutes], USERS);
 */
async function startTestServer(routers, users) {
  const app = express();
  app.set("view engine", "ejs");
  app.set("views", path.join(__dirname, "..", "views"));
  app.use((req, res, next) => {
    req.session = { user: users[req.get("X-Test-User")] };
    next();
  });
  for (const router of routers) {
    app.use(router);
  }
  app.use((error, req, res, next) => {
    res.status(error.status || 500).json({ error: error.message });
  });

  const server = await new Promise((resolve) => {
    const started = app.listen(0, () => resolve(started));
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

module.exports = { startTestServer };
