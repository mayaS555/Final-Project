// Which published articles a browser has opened (owned by C).
// This is read history for the viewed/not viewed filter. It is NOT D's view statistics:
// there are no counters here, and a repeated visit never creates a second record.

const mongoose = require("mongoose");

const articleReadSchema = new mongoose.Schema(
  {
    deviceId: { type: String, required: true },
    // No ref on purpose: the Article model belongs to B.
    articleId: { type: mongoose.Schema.Types.ObjectId, required: true },
    // Time of the latest visit.
    readAt: { type: Date, required: true },
  },
  { collection: "article_reads" }
);

// One record per device and article. It also serves "all articles this device has read".
articleReadSchema.index({ deviceId: 1, articleId: 1 }, { unique: true });

module.exports = mongoose.model("ArticleRead", articleReadSchema);
