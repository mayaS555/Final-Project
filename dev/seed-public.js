// DEVELOPMENT ONLY. Run with: node dev/seed-public.js
// Deletes every document in the collection of the dev article model and inserts fixtures.
// Before deleting, seedDevArticles() verifies that the model is on an open connection to
// the database DEV_DATABASE_NAME and uses the collection "dev_public_articles"; otherwise
// it throws and deletes nothing. It only ever calls the dev model, never another collection.

require("dotenv").config({ quiet: true });

const mongoose = require("mongoose");
const DevArticle = require("./devArticleModel");
const { connectDevDb, DEV_DATABASE_NAME } = require("./connectDevDb");

const DEV_COLLECTION_NAME = "dev_public_articles";

// Text that must never reach public output. Tests search for these markers.
const PENDING_MARKER = "PENDING-ONLY-TEXT";
const DRAFT_MARKER = "DRAFT-ONLY-TEXT";
const SSR_END_MARKER = "SSR-LAST-PARAGRAPH-MARKER";

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
      title: `${PENDING_MARKER} new title`,
      summary: `${PENDING_MARKER} new summary`,
      content: `${PENDING_MARKER} new content`,
      category: "Business",
      imageUrl: "https://example.com/pending.jpg",
      authorName: "Reporter 1",
    },
  };

  const draftOnly = {
    status: "draft",
    pending: {
      title: `${DRAFT_MARKER} title`,
      summary: `${DRAFT_MARKER} summary`,
      content: `${DRAFT_MARKER} content`,
      category: "Sports",
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
// and the dev collection.
function assertModelTargetsDevCollection(model) {
  const connection = model.db;

  if (!connection || connection.readyState !== 1) {
    throw new Error("Refusing to seed: the article model is not on an open database connection.");
  }
  if (connection.name !== DEV_DATABASE_NAME) {
    throw new Error(`Refusing to seed: the model is connected to database "${connection.name}", expected "${DEV_DATABASE_NAME}".`);
  }
  if (!model.collection || model.collection.name !== DEV_COLLECTION_NAME) {
    throw new Error(`Refusing to seed: the model uses collection "${model.collection && model.collection.name}", expected "${DEV_COLLECTION_NAME}".`);
  }
}

// Expects an open mongoose connection. Returns the ids the checks need.
// The model parameter exists so the guard can be tested with a stand-in model.
async function seedDevArticles(model = DevArticle) {
  assertModelTargetsDevCollection(model);

  const now = Date.now();
  const special = buildSpecialArticles(now);

  await model.deleteMany({});
  await model.createIndexes();

  const samples = buildSampleArticles(now);
  await model.insertMany(samples);

  // insertMany keeps input order, so the special documents can be matched by position.
  const [pendingUpdate, draftOnly, scriptInContent, unsafeImage] = await model.insertMany([
    special.pendingUpdate,
    special.draftOnly,
    special.scriptInContent,
    special.unsafeImage,
  ]);

  return {
    // 30 samples + pending update + script check + unsafe image. The draft is not counted.
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
  DEV_COLLECTION_NAME,
  PENDING_MARKER,
  DRAFT_MARKER,
  SSR_END_MARKER,
};
