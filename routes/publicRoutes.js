const express = require("express");
const publicController = require("../controllers/publicController");
const { deviceIdentity } = require("../middleware/deviceIdentity");

const router = express.Router();

// Mount this router before express.static, otherwise public/index.html answers GET /.
// deviceIdentity is attached per route so static files never receive the device cookie.
router.get("/", deviceIdentity, publicController.renderHome);
router.get("/articles/:id", deviceIdentity, publicController.renderArticle);
router.get("/api/public/articles", deviceIdentity, publicController.getFeed);

// Comment API. Mounted here so the application only has to mount this one router.
router.use(require("./commentRoutes"));

module.exports = router;
