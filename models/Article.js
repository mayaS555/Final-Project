// News articles (owned by B). Each article keeps two copies of its content:
// `approved` is the public version (read by C's publicArticleService, changed only by approval),
// `draft` is the working copy that the reporter and the editor edit; the public never sees it.
// Field names inside `approved` are the ones C's public site already reads.
// The article also embeds its guest comments (C), daily view buckets and publish events (D).

const mongoose = require("mongoose");
const { ARTICLE_CATEGORIES } = require("./articleCategories");

// Workflow state of the working copy:
//   draft     - being written, not sent to an editor yet
//   pending   - submitted, waiting for an editor
//   returned  - sent back by an editor with editorNote
//   published - approved, no open changes
// Whether an article is public does NOT depend on status: see publicFilter() below.
const ARTICLE_STATUSES = ["draft", "pending", "returned", "published"];

// Content fields shared by the working copy and the public version.
// category is added separately because the two copies validate it differently.
const contentFields = {
  title: { type: String, trim: true, maxlength: 200 },
  summary: { type: String, trim: true, maxlength: 500 },
  content: { type: String, maxlength: 50000 },
  imageUrl: { type: String, trim: true, maxlength: 2048 },
};

// Working copy. Fields may be empty while it is being written (autosave saves partial work).
const draftSchema = new mongoose.Schema(
  {
    title: { ...contentFields.title, default: "" },
    summary: { ...contentFields.summary, default: "" },
    content: { ...contentFields.content, default: "" },
    imageUrl: { ...contentFields.imageUrl, default: "" },
    // Empty until the reporter picks one, otherwise one of ARTICLE_CATEGORIES.
    category: {
      type: String,
      default: "",
      validate: {
        validator: (value) => value === "" || ARTICLE_CATEGORIES.includes(value),
        message: "Unknown category.",
      },
    },
  },
  { _id: false }
);

// Public version. Not set until the first approval.
// publishedAt is the first approval (feed order); updatedAt is the latest approval.
// authorName is copied from the author's user at approval, so the public site needs no join.
const approvedSchema = new mongoose.Schema(
  {
    ...contentFields,
    category: { type: String, enum: ARTICLE_CATEGORIES, required: true },
    authorName: { type: String, required: true },
    publishedAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
  },
  { _id: false }
);

// Guest comments on the public version (C). Fields are a proposal from C: the course requirements do not define them.
// deviceId is the internal owner (the anonymous device cookie): not selected by default, never sent to the browser.
// createdAt and updatedAt are set by commentService, never by the request. They are plain fields, not mongoose
// timestamps, because comment writes must not touch the article's own (editorial) updatedAt.
const commentSchema = new mongoose.Schema({
  deviceId: { type: String, required: true, select: false },
  displayName: { type: String, required: true },
  body: { type: String, required: true },
  createdAt: { type: Date, required: true },
  updatedAt: { type: Date, required: true },
});

// View statistics (D): views of the public version in daily UTC buckets, so a view is one $inc on the
// current bucket instead of one record per visit. The Impact Analytics page reads them.
// ponytail: buckets grow inside the article (up to 1440 minute counters a day). Fine for months of traffic;
// move them back to their own collection if an article nears MongoDB's 16 MB document limit.
const viewBucketSchema = new mongoose.Schema(
  {
    // Start of the bucket (a UTC day), so views can be drawn on a time axis.
    bucketStart: { type: Date, required: true },
    // Number of views in this bucket.
    count: { type: Number, required: true, min: 1 },
    // UTC minute offsets 0..1439. Seed daily totals have no minute breakdown.
    minuteCounts: { type: Map, of: Number, default: () => ({}) },
  },
  { _id: false }
);

// One record for every time the article went live (D). The Impact Analytics graph draws these as markers,
// so views before and after an update can be compared.
const publishEventSchema = new mongoose.Schema(
  {
    // When the editor approved this version.
    publishedAt: { type: Date, required: true },
    // 1 for the first publish, 2 for the first update, and so on.
    publishCount: { type: Number, required: true, min: 1 },
    // True only for the first publish; the analytics page can label it differently from later updates.
    isFirstPublish: { type: Boolean, required: true },
  },
  { _id: false }
);

const articleSchema = new mongoose.Schema(
  {
    // The reporter who owns the article (Person A's User model).
    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    // The author's display name, copied from the user at creation. Approval copies it into approved.authorName.
    authorName: { type: String, trim: true, required: true },
    status: { type: String, enum: ARTICLE_STATUSES, default: "draft", required: true },
    draft: { type: draftSchema, default: () => ({}) },
    approved: { type: approvedSchema, default: undefined },
    // The editor's reason when the article was returned.
    editorNote: { type: String, trim: true, default: "", maxlength: 1000 },
    // How many times the article has been approved (1 after the first publish).
    publishCount: { type: Number, default: 0, min: 0 },
    // Total page views, increased by D. C's feed sorts by it for "popular".
    totalViews: { type: Number, default: 0, min: 0 },
    // Embedded so an article carries its own comments and analytics, and deleting it removes them too.
    // Staff pages load articles without these arrays (see EMBEDDED_ARRAYS); only C's and D's services read them.
    comments: { type: [commentSchema], default: [] },
    views: { type: [viewBucketSchema], default: [] },
    publishEvents: { type: [publishEventSchema], default: [] },
  },
  { collection: "articles", timestamps: true }
);

/**
 * The query condition for "visible to the public": the article has an approved version.
 * status is ignored on purpose, so an article with open changes keeps showing its approved version.
 * @returns {Object} A new filter object each call, safe to extend ({ ...Article.publicFilter(), _id: id }).
 * @example Article.find({ ...Article.publicFilter(), "approved.category": "Sports" })
 */
articleSchema.statics.publicFilter = function publicFilter() {
  return { "approved.publishedAt": { $type: "date" } };
};

// Public feed, newest first (C). Also serves the public filter, which tests approved.publishedAt.
articleSchema.index({ "approved.publishedAt": -1, _id: -1 });
// Public feed filtered by category (C).
articleSchema.index({ "approved.category": 1, "approved.publishedAt": -1, _id: -1 });
// Title search on the public title (C). A $text query fails without it; MongoDB allows one per collection.
articleSchema.index({ "approved.title": "text" }, { default_language: "english" });
// Reporter dashboard: one author's articles, last changed first.
articleSchema.index({ author: 1, updatedAt: -1 });
// Editor dashboard: articles in one status, last changed first.
articleSchema.index({ status: 1, updatedAt: -1 });
// Finds the article of a comment for edit and delete (C).
articleSchema.index({ "comments._id": 1 });

// Projection that leaves out the embedded comments and analytics, for loads that only need the article itself.
const EMBEDDED_ARRAYS = "-comments -views -publishEvents";

module.exports = mongoose.model("Article", articleSchema);
module.exports.ARTICLE_STATUSES = ARTICLE_STATUSES;
module.exports.EMBEDDED_ARRAYS = EMBEDDED_ARRAYS;
