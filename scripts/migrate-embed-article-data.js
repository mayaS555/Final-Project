// One-off migration: moves the old `comments`, `article_views` and `publish_events` collections into their
// articles (Article.comments, Article.views, Article.publishEvents), then drops the three collections.
// Run once per database, before starting the new code on it:
//   node scripts/migrate-embed-article-data.js            (migrate)
//   node scripts/migrate-embed-article-data.js --dry-run  (only print what would happen)
// Reads MONGODB_URI / DB_NAME from .env. Writes a JSON backup of the three collections to backups/ first, and
// drops them only after checking that every record of an existing article is now inside that article.
// Records whose article no longer exists cannot be embedded; they are counted and kept in the backup only.

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const dotenv = require("dotenv");
const { EJSON } = require("mongodb").BSON;
const Article = require("../models/Article");

// Old collection -> embedded field, and the old fields the embedded entry no longer has.
const MOVES = [
  { from: "comments", into: "comments", drop: { articleId: 0, __v: 0 } },
  {
    from: "article_views",
    into: "views",
    drop: { articleId: 0, __v: 0, _id: 0 },
  },
  {
    from: "publish_events",
    into: "publishEvents",
    drop: { articleId: 0, __v: 0, _id: 0 },
  },
];

async function migrate({ dryRun }) {
  dotenv.config({ quiet: true });
  if (!process.env.MONGODB_URI) {
    throw new Error(
      "MONGODB_URI is not set. Add it to .env (see .env.example).",
    );
  }
  await mongoose.connect(
    process.env.MONGODB_URI,
    process.env.DB_NAME ? { dbName: process.env.DB_NAME } : {},
  );
  const db = mongoose.connection.db;
  const existing = new Set(
    (await db.listCollections({}, { nameOnly: true }).toArray()).map(
      (item) => item.name,
    ),
  );
  const moves = MOVES.filter((move) => existing.has(move.from));
  if (moves.length === 0) {
    console.log(
      `Nothing to migrate in "${db.databaseName}": the old collections do not exist.`,
    );
    return;
  }

  // What should end up inside the articles: every record whose article still exists.
  const expected = {};
  for (const move of moves) {
    const [row = { total: 0, kept: 0 }] = await db
      .collection(move.from)
      .aggregate([
        {
          $lookup: {
            from: "articles",
            localField: "articleId",
            foreignField: "_id",
            pipeline: [{ $project: { _id: 1 } }],
            as: "article",
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            kept: { $sum: { $size: "$article" } },
          },
        },
      ])
      .toArray();
    expected[move.into] = row.kept;
    console.log(
      `${move.from}: ${row.total} records, ${row.kept} move into articles.${move.into}, ${row.total - row.kept} orphaned`,
    );
  }

  const alreadyEmbedded = await db.collection("articles").countDocuments({
    $or: moves.map((move) => ({ [`${move.into}.0`]: { $exists: true } })),
  });
  if (alreadyEmbedded > 0) {
    throw new Error(
      `${alreadyEmbedded} articles already have embedded data. Nothing was changed; check the database by hand.`,
    );
  }
  if (dryRun) {
    console.log("Dry run: nothing was changed.");
    return;
  }

  const backupDir = path.join(
    __dirname,
    "..",
    "backups",
    `${db.databaseName}-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
  fs.mkdirSync(backupDir, { recursive: true });
  for (const move of moves) {
    const documents = await db.collection(move.from).find().toArray();
    fs.writeFileSync(
      path.join(backupDir, `${move.from}.json`),
      EJSON.stringify(documents, { relaxed: false }),
    );
  }
  console.log(`Backup written to ${backupDir}`);

  // One pass over the articles: gather each article's records and write them into it.
  await db
    .collection("articles")
    .aggregate([
      ...moves.map((move) => ({
        $lookup: {
          from: move.from,
          localField: "_id",
          foreignField: "articleId",
          pipeline: [{ $project: move.drop }],
          as: move.into,
        },
      })),
      { $project: Object.fromEntries(moves.map((move) => [move.into, 1])) },
      {
        $merge: {
          into: "articles",
          on: "_id",
          whenMatched: "merge",
          whenNotMatched: "discard",
        },
      },
    ])
    .toArray();

  const [stored = {}] = await db
    .collection("articles")
    .aggregate([
      {
        $group: {
          _id: null,
          ...Object.fromEntries(
            moves.map((move) => [
              move.into,
              { $sum: { $size: { $ifNull: [`$${move.into}`, []] } } },
            ]),
          ),
        },
      },
    ])
    .toArray();
  for (const move of moves) {
    if (stored[move.into] !== expected[move.into]) {
      throw new Error(
        `articles.${move.into} has ${stored[move.into]} entries, expected ${expected[move.into]}. ` +
          "The old collections were NOT dropped.",
      );
    }
  }

  for (const move of moves) {
    await db.collection(move.from).drop();
    console.log(
      `Dropped ${move.from} (${expected[move.into]} records now in articles.${move.into}).`,
    );
  }
  // Builds the new { "comments._id": 1 } index.
  await Article.init();
  console.log("Done.");
}

if (require.main === module) {
  migrate({ dryRun: process.argv.includes("--dry-run") })
    .catch((error) => {
      console.error(`Migration failed: ${error.message}`);
      process.exitCode = 1;
    })
    .finally(() => mongoose.disconnect());
}
