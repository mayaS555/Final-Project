// DEVELOPMENT ONLY. Run with: node dev/public-server.js
// If MongoDB is unreachable the process exits. There is no fallback to fake data.

require("dotenv").config({ quiet: true });

const { useArticleModel } = require("../services/publicArticleService");
const DevArticle = require("./devArticleModel");
const ArticleRead = require("../models/ArticleRead");
const { connectDevDb, DEV_DATABASE_NAME } = require("./connectDevDb");
const createDevApp = require("./createDevApp");

const DEV_PORT = 3100;

async function start() {
  await connectDevDb();
  // Title search fails without its text index, so wait until the indexes exist.
  await DevArticle.init();
  await ArticleRead.init();
  useArticleModel(DevArticle);

  createDevApp().listen(DEV_PORT, () => {
    console.log(`Dev public site: http://localhost:${DEV_PORT} (database ${DEV_DATABASE_NAME})`);
  });
}

start().catch((error) => {
  console.error("Could not start the dev public site:", error.message);
  process.exit(1);
});
