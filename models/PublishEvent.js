// Editor approval/publish events (owned by D): one record for every time an article goes live.
// The Impact Analytics graph draws these as markers, so views before and after an update can be compared.
// `scripts/seed.js` fills this collection for the demo.

const mongoose = require("mongoose");

const publishEventSchema = new mongoose.Schema(
  {
    // No ref on purpose: the Article model belongs to B.
    articleId: { type: mongoose.Schema.Types.ObjectId, required: true },
    // When the editor approved this version.
    publishedAt: { type: Date, required: true },
    // 1 for the first publish, 2 for the first update, and so on.
    publishCount: { type: Number, required: true, min: 1 },
    // True only for the first publish; the analytics page can label it differently from later updates.
    isFirstPublish: { type: Boolean, required: true },
  },
  { collection: "publish_events" },
);

// The markers of one article, in order.
publishEventSchema.index({ articleId: 1, publishedAt: 1 });
// An article cannot have two events with the same publish number.
publishEventSchema.index({ articleId: 1, publishCount: 1 }, { unique: true });

module.exports = mongoose.model("PublishEvent", publishEventSchema);
