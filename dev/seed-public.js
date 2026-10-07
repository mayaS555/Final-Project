// DEVELOPMENT ONLY. Run with: node dev/seed-public.js
// Deletes every document in the collection of the dev article model and in the read-history
// collection "article_reads", then inserts fixtures (new article ids make old read records useless).
// Before deleting, seedDevArticles() verifies that each model is on an open connection to
// the database DEV_DATABASE_NAME and uses its expected collection; otherwise
// it throws and deletes nothing. It only ever calls those two models, never another collection.

require("dotenv").config({ quiet: true });

const mongoose = require("mongoose");
const DevArticle = require("./devArticleModel");
const ArticleRead = require("../models/ArticleRead");
const { connectDevDb, DEV_DATABASE_NAME } = require("./connectDevDb");

const DEV_COLLECTION_NAME = "dev_public_articles";
const DEV_READ_COLLECTION_NAME = "article_reads";

// Text that must never reach public output. Tests search for these markers.
// The words and categories below exist only in pending or draft revisions, so no public
// search or category filter may ever find them.
const PENDING_MARKER = "PENDING-ONLY-TEXT";
const DRAFT_MARKER = "DRAFT-ONLY-TEXT";
const SSR_END_MARKER = "SSR-LAST-PARAGRAPH-MARKER";
const PENDING_ONLY_WORD = "zyxpendingword";
const PENDING_ONLY_CATEGORY = "PendingOnlyCategory";
const DRAFT_ONLY_WORD = "zyxdraftword";
const DRAFT_ONLY_CATEGORY = "DraftOnlyCategory";

const CATEGORIES = ["Technology", "Sports", "Culture", "Science", "Business"];
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function buildSampleArticles(now) {
  const samples = [];

  // 30 plain approved articles. Dates repeat in groups of three to exercise the _id tie-breaker.
  for (let index = 1; index <= 30; index += 1) {
    const publishedAt = new Date(now - (2 + Math.floor(index / 3)) * DAY);
    const label = String(index).padStart(2, "0");
    samples.push({
      status: "published",
      approved: {
        title: `Sample article ${label}`,
        summary: `Short summary of sample article ${label}.`,
        content: `First paragraph of sample article ${label}.\n\nSecond paragraph of sample article ${label}.`,
        category: CATEGORIES[index % CATEGORIES.length],
        imageUrl: "https://picsum.photos/seed/daily-web-" + label + "/600/300",
        authorName: `Reporter ${(index % 4) + 1}`,
        publishedAt,
        updatedAt: publishedAt,
      },
    });
  }

  return samples;
}

function buildApprovedArticle({ title, category, publishedAt, number }) {
  return {
    status: "published",
    approved: {
      title,
      summary: `Search fixture summary ${number}.`,
      content: `Search fixture content ${number}.`,
      category,
      imageUrl: null,
      authorName: `Reporter ${(number % 4) + 1}`,
      publishedAt,
      updatedAt: publishedAt,
    },
  };
}

// Data for search and category checks, all older than the other fixtures:
//   q=harbor                  -> 28 articles (25 Markets + 3 in other categories)
//   category=Markets          -> 27 articles (25 harbor reports + 2 without "harbor")
//   q=harbor & category=Markets -> 25 articles
// Each result is larger than one page of 20, so the second filtered page is exercised.
function buildSearchFixtureArticles(now) {
  const articles = [];

  for (let index = 1; index <= 25; index += 1) {
    const publishedAt = new Date(now - (30 + Math.floor(index / 2)) * DAY);
    const label = String(index).padStart(2, "0");
    articles.push(buildApprovedArticle({ title: `Harbor report ${label}`, category: "Markets", publishedAt, number: index }));
  }

  const otherHarborTitles = [
    { title: "Harbor festival opens this weekend", category: "Culture" },
    { title: "New harbor bridge approved", category: "Business" },
    { title: "Harbor swim returns", category: "Sports" },
  ];
  otherHarborTitles.forEach((entry, offset) => {
    const publishedAt = new Date(now - (50 + offset) * DAY);
    articles.push(buildApprovedArticle({ ...entry, publishedAt, number: 100 + offset }));
  });

  const otherMarketsTitles = ["Stocks close higher", "Currency markets steady"];
  otherMarketsTitles.forEach((title, offset) => {
    const publishedAt = new Date(now - (60 + offset) * DAY);
    articles.push(buildApprovedArticle({ title, category: "Markets", publishedAt, number: 200 + offset }));
  });

  return articles;
}

function buildSpecialArticles(now) {
  const pendingUpdate = {
    status: "pending",
    approved: {
      title: "Approved version: city opens new library",
      summary: "Approved summary shown to the public.",
      content: `Approved paragraph one.\n\nApproved paragraph two with a line\nbreak inside it.\n\n${SSR_END_MARKER}`,
      category: "Culture",
      imageUrl: "https://picsum.photos/seed/daily-web-library/600/300",
      authorName: "Reporter 1",
      publishedAt: new Date(now - 1 * HOUR),
      updatedAt: new Date(now - 1 * HOUR),
    },
    pending: {
      title: `${PENDING_MARKER} ${PENDING_ONLY_WORD} new title`,
      summary: `${PENDING_MARKER} new summary`,
      content: `${PENDING_MARKER} new content`,
      category: PENDING_ONLY_CATEGORY,
      imageUrl: "https://example.com/pending.jpg",
      authorName: "Reporter 1",
    },
  };

  const draftOnly = {
    status: "draft",
    pending: {
      title: `${DRAFT_MARKER} ${DRAFT_ONLY_WORD} title`,
      summary: `${DRAFT_MARKER} summary`,
      content: `${DRAFT_MARKER} content`,
      category: DRAFT_ONLY_CATEGORY,
      authorName: "Reporter 2",
    },
  };

  const scriptInContent = {
    status: "published",
    approved: {
      title: "Escaping check <b>bold title</b>",
      summary: "Summary with <i>markup</i>.",
      content: "Text with <script>alert('xss')</script> inside.",
      category: "Technology",
      imageUrl: "https://picsum.photos/seed/daily-web-escape/600/300",
      authorName: "Reporter 3",
      publishedAt: new Date(now - 2 * HOUR),
      updatedAt: new Date(now - 2 * HOUR),
    },
  };

  const unsafeImage = {
    status: "published",
    approved: {
      title: "Unsafe image URL check",
      summary: "The image URL of this article must not be rendered.",
      content: "Body of the article with an unsafe image URL.",
      category: "Science",
      imageUrl: "javascript:alert(1)",
      authorName: "Reporter 4",
      publishedAt: new Date(now - 3 * HOUR),
      updatedAt: new Date(now - 3 * HOUR),
    },
  };

  return { pendingUpdate, draftOnly, scriptInContent, unsafeImage };
}

// Checks the connection that the model itself is bound to, not the URI or the environment.
// Throws before any write if the model is not on an open connection to the dev database
// and the expected dev collection.
function assertModelTargetsDevCollection(model, expectedCollectionName = DEV_COLLECTION_NAME) {
  const connection = model.db;

  if (!connection || connection.readyState !== 1) {
    throw new Error("Refusing to seed: the article model is not on an open database connection.");
  }
  if (connection.name !== DEV_DATABASE_NAME) {
    throw new Error(`Refusing to seed: the model is connected to database "${connection.name}", expected "${DEV_DATABASE_NAME}".`);
  }
  if (!model.collection || model.collection.name !== expectedCollectionName) {
    throw new Error(`Refusing to seed: the model uses collection "${model.collection && model.collection.name}", expected "${expectedCollectionName}".`);
  }
}

// Removes all read history. Used by the seed and by the tests, only after the same checks.
async function clearDevArticleReads(readModel = ArticleRead) {
  assertModelTargetsDevCollection(readModel, DEV_READ_COLLECTION_NAME);
  await readModel.deleteMany({});
}

// Expects an open mongoose connection. Returns the ids the checks need.
// The model parameter exists so the guard can be tested with a stand-in model.
async function seedDevArticles(model = DevArticle, readModel = ArticleRead) {
  // Both guards run before the first delete.
  assertModelTargetsDevCollection(model);
  assertModelTargetsDevCollection(readModel, DEV_READ_COLLECTION_NAME);

  const now = Date.now();
  const special = buildSpecialArticles(now);

  await model.deleteMany({});
  await clearDevArticleReads(readModel);
  await model.createIndexes();
  await readModel.createIndexes();

  const samples = [...buildSampleArticles(now), ...buildSearchFixtureArticles(now)];
  await model.insertMany(samples);

  // insertMany keeps input order, so the special documents can be matched by position.
  const [pendingUpdate, draftOnly, scriptInContent, unsafeImage] = await model.insertMany([
    special.pendingUpdate,
    special.draftOnly,
    special.scriptInContent,
    special.unsafeImage,
  ]);

  return {
    // Every sample is approved, plus pending update + script check + unsafe image. The draft is not counted.
    approvedCount: samples.length + 3,
    pendingUpdateId: String(pendingUpdate._id),
    draftOnlyId: String(draftOnly._id),
    scriptInContentId: String(scriptInContent._id),
    unsafeImageId: String(unsafeImage._id),
  };
}

async function main() {
  await connectDevDb();
  const result = await seedDevArticles();
  console.log(`Seeded database ${DEV_DATABASE_NAME}, collection ${DEV_COLLECTION_NAME}.`);
  console.log(result);
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error("Seeding failed:", error.message);
      process.exitCode = 1;
    })
    .finally(() => mongoose.disconnect());
}

module.exports = {
  seedDevArticles,
  assertModelTargetsDevCollection,
  clearDevArticleReads,
  DEV_COLLECTION_NAME,
  DEV_READ_COLLECTION_NAME,
  PENDING_MARKER,
  DRAFT_MARKER,
  SSR_END_MARKER,
  PENDING_ONLY_WORD,
  PENDING_ONLY_CATEGORY,
  DRAFT_ONLY_WORD,
  DRAFT_ONLY_CATEGORY,
};
