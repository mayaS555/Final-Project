// View statistics (owned by D): how many times a public article was opened, in time buckets.
// `scripts/seed.js` fills this collection for the demo; the Impact Analytics page reads it.
// A bucket keeps the collection small even with thousands of readers, because a view is one $inc
// on the current bucket instead of one document per visit.

const mongoose = require("mongoose");

const articleViewSchema = new mongoose.Schema(
  {
    // No ref on purpose: the Article model belongs to B.
    articleId: { type: mongoose.Schema.Types.ObjectId, required: true },
    // Start of the bucket (a UTC day in the seed), so views can be drawn on a time axis.
    bucketStart: { type: Date, required: true },
    // Number of views in this bucket.
    count: { type: Number, required: true, min: 1 },
    // UTC minute offsets 0..1439. Legacy/seed daily totals have no minute breakdown.
    minuteCounts: { type: Map, of: Number, default: () => ({}) },
  },
  { collection: "article_views" },
);

// One counter per article and bucket; lets the application record a view with an upsert + $inc.
articleViewSchema.index({ articleId: 1, bucketStart: 1 }, { unique: true });
// Views of every article in a date range, for an overview chart.
articleViewSchema.index({ bucketStart: 1 });

module.exports = mongoose.model("ArticleView", articleViewSchema);
