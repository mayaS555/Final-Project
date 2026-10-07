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
  },
  { collection: "dev_public_articles" }
);

// Proposed feed index for B's schema: matches the date-sorted feed query.
devArticleSchema.index({ "approved.publishedAt": -1, _id: -1 });

const DevArticle = mongoose.model("DevArticle", devArticleSchema);

module.exports = DevArticle;
