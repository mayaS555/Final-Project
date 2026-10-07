const express = require("express");
const publicController = require("../controllers/publicController");

const router = express.Router();

// Mount this router before express.static, otherwise public/index.html answers GET /.
router.get("/", publicController.renderHome);
router.get("/articles/:id", publicController.renderArticle);
router.get("/api/public/articles", publicController.getFeed);

module.exports = router;
