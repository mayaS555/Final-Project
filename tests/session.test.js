// Verifies that a login survives a fresh app instance, which is what a server restart creates.
// Needs MongoDB (MONGODB_TEST_URI); without it the test is skipped. Each test file gets its own test database
// (see tests/testDatabase.js).
// Run: node --test tests/

const { describe, test, before, after } = require("node:test");
const assert = require("assert");
const mongoose = require("mongoose");
const User = require("../models/User");
const {
  skipWithoutDatabase,
  connectTestDatabase,
  disconnectTestDatabase,
} = require("./testDatabase");

const USER = {
  name: "Session Reporter",
  email: "session-reporter@example.com",
  password: "pass123",
  role: "reporter",
};

/**
 * Loads a fresh copy of server.js, as a restart would, and starts it on a free port.
 * @returns {Promise<{ server: import("http").Server, baseUrl: string }>} The listening app.
 * @example const { server, baseUrl } = await startFreshApp();
 */
async function startFreshApp() {
  // server.js builds the session middleware at require time, so dropping it from the cache creates
  // a new session store. A MemoryStore would lose the session here; the MongoDB store keeps it.
  delete require.cache[require.resolve("../server")];
  process.env.SESSION_SECRET = "session-test-secret";
  // dotenv must not point the store at the development database instead of this process's test database.
  process.env.DB_NAME = mongoose.connection.name;

  const app = require("../server");
  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

/**
 * Stops a server started by startFreshApp.
 * @param {import("http").Server} server The server to close.
 * @returns {Promise<void>} Resolves when the port is released.
 * @example await stopApp(server);
 */
function stopApp(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe("session persistence", { skip: skipWithoutDatabase }, () => {
  before(async () => {
    await connectTestDatabase();
    await User.create(USER);
  });
  after(disconnectTestDatabase);

  test("a login cookie still identifies the user after the app is restarted", async () => {
    let cookie;
    const firstApp = await startFreshApp();
    try {
      const login = await fetch(`${firstApp.baseUrl}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: USER.email, password: USER.password }),
      });
      assert.equal(login.status, 200);
      cookie = login.headers.getSetCookie()[0].split(";")[0];
      assert.match(cookie, /^connect\.sid=/);
    } finally {
      await stopApp(firstApp.server);
    }

    const secondApp = await startFreshApp();
    try {
      const me = await fetch(`${secondApp.baseUrl}/api/auth/me`, {
        headers: { Cookie: cookie },
      });
      assert.equal(me.status, 200);
      const body = await me.json();
      assert.equal(body.user.email, USER.email);
      assert.equal(body.user.role, USER.role);
    } finally {
      await stopApp(secondApp.server);
    }
  });
});
