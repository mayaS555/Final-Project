const express = require("express");
const commentController = require("../controllers/commentController");
const { deviceIdentity } = require("../middleware/deviceIdentity");

const router = express.Router();

// Writes must be application/json (a charset parameter is fine). This is checked explicitly:
// the shared server may already run express.urlencoded() before this router, which fills req.body
// from a plain HTML form, so an empty req.body cannot be assumed. Rejecting here also means a
// cross-site HTML form cannot create or change a comment, and the request never reaches the
// controller, the rate limiter or the database.
function requireJsonContentType(req, res, next) {
  if (!req.is("application/json")) {
    res.status(415).json({ error: "Comments must be sent as application/json." });
    return;
  }
  next();
}

// The JSON parser is attached only to the routes that read a body.
const readJsonBody = express.json({ limit: "10kb" });

// The article id is checked inside the controller: the article must have an approved public version.
router.get("/api/public/articles/:id/comments", deviceIdentity, commentController.listComments);
router.post("/api/public/articles/:id/comments", deviceIdentity, requireJsonContentType, readJsonBody, commentController.createComment);
router.patch("/api/public/comments/:id", deviceIdentity, requireJsonContentType, readJsonBody, commentController.updateComment);
router.delete("/api/public/comments/:id", deviceIdentity, commentController.deleteComment);

// Malformed or oversized JSON would otherwise reach Express's default HTML error page.
router.use((error, req, res, next) => {
  if (error.type === "entity.parse.failed") {
    res.status(400).json({ error: "The request body is not valid JSON." });
    return;
  }
  if (error.type === "entity.too.large") {
    res.status(413).json({ error: "The request body is too large." });
    return;
  }
  next(error);
});

module.exports = router;
