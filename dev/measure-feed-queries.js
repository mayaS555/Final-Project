// DEVELOPMENT ONLY. Run with: node dev/measure-feed-queries.js
// With --candidate-indexes the bench collection also gets the popularity indexes listed below, to
// see what they would change. They are not part of the dev article model unless the findings say so.
// Measures the public feed queries on about 5000 generated articles. Local, single-user numbers:
// they say nothing about behavior under many simultaneous users.
//
// All writes go to one separate collection, "dev_public_articles_bench", of the dev database.
// assertBenchTarget() checks the open connection, the database and the collection name before
// the script deletes or inserts anything. The normal dev collections (articles, article_reads,
// comments) are never read or written. The bench collection is dropped at the start (so no data
// or index from an earlier run can remain) and again at the end.
// The article service is used as it is: a thin wrapper model only remembers the query that the
// service built, so the same query can be explained.

require("dotenv").config({ quiet: true });

const mongoose = require("mongoose");
// Loading the dev article model must not create its collection or indexes. Everything is created
// explicitly below, and only for the bench collection.
mongoose.set("autoIndex", false);
mongoose.set("autoCreate", false);

const DevArticle = require("./devArticleModel");
const { connectDevDb, DEV_DATABASE_NAME } = require("./connectDevDb");
const service = require("../services/publicArticleService");

const BENCH_COLLECTION_NAME = "dev_public_articles_bench";
const ARTICLE_COUNT = 5000;
const WARMUP_RUNS = 3;
const TIMED_RUNS = 15;
const DAY = 24 * 60 * 60 * 1000;

const CANDIDATE_INDEXES = [
  { totalViews: -1, "approved.publishedAt": -1, _id: -1 },
  { "approved.category": 1, totalViews: -1, "approved.publishedAt": -1, _id: -1 },
];

// Same schema and indexes as the dev article model, stored in the bench collection.
const BenchArticle = mongoose.model("DevArticleBench", DevArticle.schema, BENCH_COLLECTION_NAME);

function assertBenchTarget(model) {
  const connection = model.db;
  if (!connection || connection.readyState !== 1) {
    throw new Error("Refusing to run: the bench model is not on an open database connection.");
  }
  if (connection.name !== DEV_DATABASE_NAME) {
    throw new Error(`Refusing to run: connected to database "${connection.name}", expected "${DEV_DATABASE_NAME}".`);
  }
  if (!model.collection || model.collection.name !== BENCH_COLLECTION_NAME) {
    throw new Error(`Refusing to run: the model uses collection "${model.collection && model.collection.name}", expected "${BENCH_COLLECTION_NAME}".`);
  }
}

// Removes the bench collection with its data and indexes. A missing collection is not an error.
async function dropBenchCollection() {
  assertBenchTarget(BenchArticle);
  try {
    await BenchArticle.collection.drop();
  } catch (error) {
    if (error.codeName !== "NamespaceNotFound") {
      throw error;
    }
  }
}

// Small seeded generator, so every run builds the same data.
function createRandom(seed) {
  let state = seed;
  return function random() {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const CATEGORIES = ["Technology", "Sports", "Culture", "Science", "Business", "Markets", "Health", "World"];
const ADJECTIVES = ["Early", "Late", "New", "Final", "Local", "Global", "Quiet", "Busy", "Open", "Rare", "Annual", "Urgent"];
const NOUNS = ["market", "harbor", "council", "festival", "bridge", "season", "report", "budget", "league", "museum", "storm", "summit"];
const PLACES = ["Oslo", "Lisbon", "Cairo", "Lima", "Hanoi", "Perth", "Quito", "Turin", "Accra", "Dublin", "Seoul", "Tallinn", "Nairobi", "Bergen", "Porto", "Zagreb", "Malmo", "Vienna", "Prague", "Sofia", "Riga", "Cork", "Baku", "Tunis", "Split", "Pula", "Brno", "Gdansk", "Bilbao", "Reykjavik"];

function buildArticles(now) {
  const random = createRandom(20261008);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const articles = [];

  for (let number = 1; number <= ARTICLE_COUNT; number += 1) {
    const title = `${pick(ADJECTIVES)} ${pick(NOUNS)} in ${pick(PLACES)} ${number}`;
    // The first categories are used more often than the last ones.
    const category = CATEGORIES[Math.floor(Math.pow(random(), 1.5) * CATEGORIES.length)];
    // Skewed counts with many zeros and repeats, so ties are common.
    const totalViews = random() < 0.2 ? 0 : Math.floor(Math.pow(random(), 3) * 20000);

    const kind = random();
    if (kind < 0.05) {
      articles.push({ status: "draft", totalViews, pending: { title, summary: "Draft", content: "Draft", category, authorName: "Reporter 1" } });
      continue;
    }

    // About 30 percent of the articles get a date without a time-of-day offset (a whole number of days
    // before the run). Those can share the exact same date; the other dates are almost never equal.
    const dayOffset = Math.floor(random() * 730);
    const publishedAt = new Date(now - dayOffset * DAY - (random() < 0.3 ? 0 : Math.floor(random() * DAY)));
    const article = {
      status: kind < 0.15 ? "pending" : "published",
      totalViews,
      approved: {
        title,
        summary: `Summary of article ${number}.`,
        content: `Content of article ${number}.`,
        category,
        imageUrl: null,
        authorName: `Reporter ${(number % 4) + 1}`,
        publishedAt,
        updatedAt: publishedAt,
      },
    };
    if (article.status === "pending") {
      article.pending = { title: `${title} revised`, summary: "Revised", content: "Revised", category, authorName: article.approved.authorName };
    }
    articles.push(article);
  }
  return articles;
}

// Deterministic shuffle, used to choose which public articles count as already read.
function pickReadIds(publicIds, count) {
  const random = createRandom(7);
  const ids = publicIds.slice();
  for (let index = ids.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [ids[index], ids[other]] = [ids[other], ids[index]];
  }
  return ids.slice(0, count);
}

// The service reads the article model through useArticleModel(). This wrapper passes every call
// on and keeps the last find() query, so its filter, sort, skip and limit can be explained.
function createRecordingModel() {
  const recorder = {
    lastQuery: null,
    find(filter, projection) {
      recorder.lastQuery = BenchArticle.find(filter, projection);
      return recorder.lastQuery;
    },
    distinct: (...args) => BenchArticle.distinct(...args),
  };
  return recorder;
}

function collectStages(node, found = []) {
  if (!node) {
    return found;
  }
  if (node.stage) {
    found.push(node.indexName ? `${node.stage}[${node.indexName}]` : node.stage);
  }
  collectStages(node.queryPlan, found);
  collectStages(node.inputStage, found);
  (node.inputStages || []).forEach((child) => collectStages(child, found));
  return found;
}

function median(values) {
  const sorted = values.slice().sort((first, second) => first - second);
  return sorted[Math.floor(sorted.length / 2)];
}

async function timeRuns(run) {
  for (let count = 0; count < WARMUP_RUNS; count += 1) {
    await run();
  }
  const times = [];
  for (let count = 0; count < TIMED_RUNS; count += 1) {
    const start = process.hrtime.bigint();
    await run();
    times.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  return { median: median(times), max: Math.max(...times), lastResult: await run() };
}

async function measureFeedQuery(recorder, args, expectedResultCount) {
  const timing = await timeRuns(() => service.getPublishedArticles(args));
  const resultCount = timing.lastResult.items.length;
  if (expectedResultCount === "some" ? resultCount === 0 : resultCount !== expectedResultCount) {
    throw new Error(`Unexpected result count ${resultCount} for ${JSON.stringify({ ...args, readArticleIds: undefined })}`);
  }

  const query = recorder.lastQuery;
  const options = query.getOptions();
  const explain = await BenchArticle.find(query.getFilter(), query.projection())
    .sort(options.sort)
    .skip(options.skip)
    .limit(options.limit)
    .explain("executionStats");
  const stats = explain.executionStats;
  const planRoot = explain.queryPlanner.winningPlan;

  return {
    timing,
    keys: stats.totalKeysExamined,
    docs: stats.totalDocsExamined,
    resultCount,
    serverMs: stats.executionTimeMillis,
    stages: collectStages(planRoot).join(" > "),
  };
}

function formatMs(value) {
  return value.toFixed(1);
}

async function main() {
  await connectDevDb();
  assertBenchTarget(BenchArticle);

  const info = await mongoose.connection.db.admin().serverInfo();
  const now = Date.now();
  const articles = buildArticles(now);

  // Guard first, then everything below touches only the bench collection. Starting from a dropped
  // collection means no earlier data or index (for example a candidate index) can remain.
  await dropBenchCollection();
  await BenchArticle.insertMany(articles, { lean: true });
  await BenchArticle.createIndexes();
  if (process.argv.includes("--candidate-indexes")) {
    for (const key of CANDIDATE_INDEXES) {
      await BenchArticle.collection.createIndex(key);
    }
  }

  const publicDocuments = await BenchArticle.find({ "approved.publishedAt": { $type: "date" } }, { _id: 1 }).lean();
  const publicIds = publicDocuments.map((document) => String(document._id));
  const read1000 = pickReadIds(publicIds, 1000);
  const read4000 = pickReadIds(publicIds, 4000);

  const indexes = await BenchArticle.collection.indexes();
  console.log(`MongoDB ${info.version}, Node ${process.version}, database ${DEV_DATABASE_NAME}, collection ${BENCH_COLLECTION_NAME}`);
  console.log(`Documents: ${articles.length}, public (approved): ${publicIds.length}, with a pending revision: ${articles.filter((entry) => entry.status === "pending").length}, draft only: ${articles.filter((entry) => entry.status === "draft").length}`);
  console.log(`Indexes: ${indexes.map((index) => index.name).join(", ")}`);
  console.log(`Runs per query: ${WARMUP_RUNS} warm-up, ${TIMED_RUNS} timed. Times are milliseconds of the service call (median, max). Keys, docs and server ms come from explain("executionStats").`);
  console.log("");

  const recorder = createRecordingModel();
  service.useArticleModel(recorder);

  // expect: "some" means the page must contain articles, a number is the exact count of the page.
  const queries = [
    { label: "no filter, page 1", args: { page: 1 } },
    { label: "no filter, page 200 (deep, 20 articles)", args: { page: 200 }, expect: 20 },
    { label: "no filter, page 250 (past the end, 0 articles)", args: { page: 250 }, expect: 0 },
    { label: "category Technology", args: { page: 1, category: "Technology" } },
    { label: "category Health", args: { page: 1, category: "Health" } },
    { label: "search market", args: { page: 1, q: "market" } },
    { label: "search Reykjavik", args: { page: 1, q: "Reykjavik" } },
    { label: "search market + category Markets", args: { page: 1, q: "market", category: "Markets" } },
    { label: "unviewed, 1000 read", args: { page: 1, viewed: "unviewed", readArticleIds: read1000 } },
    { label: "unviewed, 4000 read", args: { page: 1, viewed: "unviewed", readArticleIds: read4000 } },
    { label: "viewed, 1000 read", args: { page: 1, viewed: "viewed", readArticleIds: read1000 } },
    { label: "category Technology + unviewed, 1000 read", args: { page: 1, category: "Technology", viewed: "unviewed", readArticleIds: read1000 } },
    { label: "search market + category Markets + unviewed, 1000 read", args: { page: 1, q: "market", category: "Markets", viewed: "unviewed", readArticleIds: read1000 } },
  ];

  console.log("| Query | Sort | Median ms | Max ms | Keys | Docs | Articles on page | Server ms | Plan |");
  console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const query of queries) {
    for (const sort of ["date", "popular"]) {
      const result = await measureFeedQuery(recorder, { ...query.args, sort }, query.expect === undefined ? "some" : query.expect);
      console.log(`| ${query.label} | ${sort} | ${formatMs(result.timing.median)} | ${formatMs(result.timing.max)} | ${result.keys} | ${result.docs} | ${result.resultCount} | ${result.serverMs} | ${result.stages} |`);
    }
  }

  const categories = await timeRuns(() => service.getPublishedCategories());
  console.log("");
  console.log(`getPublishedCategories(): median ${formatMs(categories.median)} ms, max ${formatMs(categories.max)} ms`);
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error("Measurement failed:", error.message);
      process.exitCode = 1;
    })
    .finally(async () => {
      // Remove the bench data again. The guard runs inside dropBenchCollection().
      try {
        if (mongoose.connection.readyState === 1) {
          await dropBenchCollection();
        }
      } catch (error) {
        console.error("Could not drop the bench collection:", error.message);
        process.exitCode = 1;
      }
      await mongoose.disconnect();
    });
}

module.exports = { assertBenchTarget, BenchArticle, BENCH_COLLECTION_NAME };
