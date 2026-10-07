// DEVELOPMENT ONLY. Builds an Express app with just the public module, without
// the team's server.js. The article model is connected separately (see public-server.js).

const path = require("path");
const express = require("express");
const publicRoutes = require("../routes/publicRoutes");

function createDevApp() {
  const projectRoot = path.join(__dirname, "..");
  const app = express();

  app.set("view engine", "ejs");
  app.set("views", path.join(projectRoot, "views"));
  app.locals.devNotice = "Development mode: showing fixture articles from the dev database.";

  // Routes first, so GET / is served by EJS and not by public/index.html.
  app.use(publicRoutes);
  app.use(express.static(path.join(projectRoot, "public"), { index: false }));

  return app;
}

module.exports = createDevApp;
