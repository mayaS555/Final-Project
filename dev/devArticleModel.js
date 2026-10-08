// DEVELOPMENT ONLY. This is not the production Article model (B owns that).
// It exists so the public feed can be exercised against real MongoDB queries.
// Data lives in its own collection inside the isolated dev database.

const mongoose = require("mongoose");

const approvedVersion = {
  title: String,
  summary: String,
  content: String,
  category: String,
  imageUrl: String,
  authorName: String,
  publishedAt: Date,
  updatedAt: Date,
};

const pendingVersion = {
  title: String,
  summary: String,
  content: String,
  category: String,
  imageUrl: String,
  authorName: String,
};

const devArticleSchema = new mongoose.Schema(
  {
    // Workflow state of the latest revision. Public queries must not rely on it.
    status: { type: String, enum: ["draft", "pending", "published"], required: true },
    approved: approvedVersion,
    pending: pendingVersion,
    // Popularity input for the sort=popular feed. DEV FIXTURE ONLY: B's schema and D's counter are
    // not agreed. C only reads it; nothing in C increments it. Not versioned: views belong to the article.
    totalViews: { type: Number, default: 0, min: 0 },
  },
  { collection: "dev_public_articles" }
);

// Proposed feed indexes for B's schema.
// Date-sorted feed:
devArticleSchema.index({ "approved.publishedAt": -1, _id: -1 });
// Category filter with the same sort, and the distinct list of categories:
devArticleSchema.index({ "approved.category": 1, "approved.publishedAt": -1, _id: -1 });
// Title search. Only the approved title is indexed, so pending titles can never match.
// The language decides stemming and stop words; see docs/person-c-integration.md.
devArticleSchema.index(
  { "approved.title": "text" },
  { name: "approved_title_text", default_language: "english" }
);

const DevArticle = mongoose.model("DevArticle", devArticleSchema);

module.exports = DevArticle;
