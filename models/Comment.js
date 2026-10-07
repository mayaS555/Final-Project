// Guest comments on public articles (owned by C).
// Fields are a proposal from C: the course requirements do not define them.

const mongoose = require("mongoose");

const commentSchema = new mongoose.Schema(
  {
    // No ref on purpose: the Article model belongs to B.
    articleId: { type: mongoose.Schema.Types.ObjectId, required: true },
    // Internal owner (the anonymous device cookie). It is not selected by default
    // and is never sent to the browser.
    deviceId: { type: String, required: true, select: false },
    displayName: { type: String, required: true },
    body: { type: String, required: true },
  },
  // createdAt and updatedAt are set by the server, never by the request.
  { collection: "comments", timestamps: true }
);

// Comments of one article, newest first, with _id as the tie-breaker for equal dates.
commentSchema.index({ articleId: 1, createdAt: -1, _id: -1 });

module.exports = mongoose.model("Comment", commentSchema);
