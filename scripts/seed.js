// Development seed (owned by B): replaces all articles with 500 generated ones in every workflow state.
// Run with `npm run seed`. Reads MONGODB_URI from .env, refuses to run when NODE_ENV=production, and deletes
// ONLY the articles collection. It does not touch comments, read history, views or publish events (C's and D's).
// The documents have exactly the shape articleService gives real articles: working copy (draft) + public version.

const mongoose = require("mongoose");
const dotenv = require("dotenv");
const Article = require("../models/Article");
const { ARTICLE_CATEGORIES } = require("../models/articleCategories");

const ARTICLE_COUNT = 500;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// Published dates are spread over this many days before the seed runs.
const PUBLISHED_DAYS = 60;
// How many published articles get 2-5 approvals, for D's before/after analytics.
const MULTI_UPDATE_COUNT = 15;

// ponytail: fixed reporter ids and names until A's User model exists; then create these users through A's model
// (so password hashing runs) and use their real ids here.
const REPORTERS = [
  { id: "665000000000000000000001", name: "Noa Levi" },
  { id: "665000000000000000000002", name: "Daniel Cohen" },
  { id: "665000000000000000000003", name: "Yael Mizrahi" },
  { id: "665000000000000000000004", name: "Omer Friedman" },
  { id: "665000000000000000000005", name: "Maya Shapiro" },
];

// How many articles of each kind (adds up to ARTICLE_COUNT). "revision" is a published article with a newer
// version waiting for an editor: status pending, approved still public.
const STATE_PLAN = [
  ["published", 275],
  ["pending", 75],
  ["revision", 50],
  ["draft", 50],
  ["returned", 50],
];

// Title parts per category: "<subject> <action> <object>", sometimes followed by " in <place>".
// The text is English because the title search uses MongoDB's English text index.
const TITLE_WORDS = {
  General: {
    subjects: ["Residents", "Volunteers", "Commuters", "Students", "Parents", "Shop owners"],
    actions: ["welcome", "complain about", "organize", "prepare for", "vote on", "clean up"],
    objects: ["the new bike lanes", "a neighbourhood festival", "longer library hours", "the beach before summer", "changes to school hours", "a community garden"],
  },
  Politics: {
    subjects: ["City council", "A parliament committee", "The mayor", "Opposition leaders", "Election officials", "The finance minister"],
    actions: ["approves", "debates", "rejects", "delays", "announces", "reviews"],
    objects: ["a new housing plan", "the public transport budget", "a reform of local taxes", "changes to the voting system", "a plan for night buses", "new rules for street parking"],
  },
  World: {
    subjects: ["European leaders", "UN envoys", "Neighbouring countries", "Aid groups", "Foreign ministers", "Trade negotiators"],
    actions: ["agree on", "meet to discuss", "warn about", "sign", "push for", "postpone"],
    objects: ["a ceasefire plan", "new trade rules", "climate targets", "a refugee aid package", "border talks", "a water-sharing deal"],
  },
  Economy: {
    subjects: ["Local businesses", "The central bank", "Tech startups", "Farmers", "Retail chains", "Port operators"],
    actions: ["report", "expect", "prepare for", "struggle with", "benefit from", "invest in"],
    objects: ["higher interest rates", "a record harvest", "rising fuel prices", "the harbor expansion", "new export markets", "lower consumer spending"],
  },
  Technology: {
    subjects: ["University researchers", "A local startup", "The city", "Hospitals", "Schools", "Engineers"],
    actions: ["test", "launch", "adopt", "build", "warn about", "upgrade"],
    objects: ["a solar-powered bus", "AI homework tutors", "a public Wi-Fi network", "faster fibre internet", "smart traffic lights", "an app for reporting potholes"],
  },
  Sports: {
    subjects: ["The national team", "The local football club", "Young swimmers", "The basketball league", "Marathon runners", "The women's volleyball team"],
    actions: ["win", "lose", "prepare for", "celebrate", "qualify for", "sign"],
    objects: ["the regional cup", "the season opener", "a new coach", "the national finals", "a record crowd", "the European championship"],
  },
  Culture: {
    subjects: ["The film festival", "The city museum", "Local artists", "The national theatre", "Street musicians", "The public library"],
    actions: ["opens", "celebrates", "announces", "hosts", "restores", "brings back"],
    objects: ["a new exhibition", "its 50th season", "a free summer concert series", "a reading week for children", "the old train station", "a street food festival"],
  },
  Health: {
    subjects: ["Doctors", "The health ministry", "The city hospital", "Nurses", "Researchers", "Pharmacies"],
    actions: ["warn about", "launch", "recommend", "open", "study", "expand"],
    objects: ["the flu vaccine campaign", "a new emergency wing", "more walking after work", "free check-ups for seniors", "the effects of screen time", "night-time services"],
  },
};
const PLACES = ["Haifa", "Tel Aviv", "Jerusalem", "Beersheba", "the north", "the city center", "the old port"];
const SUMMARY_ENDINGS = [
  "Here is what it means for residents.",
  "Officials expect a decision within weeks.",
  "Critics say more time is needed.",
  "The change takes effect next month.",
  "Our reporter spoke with the people involved.",
];
const PARAGRAPHS = [
  "The decision follows months of discussion, and not everyone is convinced it goes far enough.",
  "Officials said the details would be published on the city's website in the coming days.",
  "Several residents told The Daily Web they had heard about the plan only last week.",
  "Supporters say the change is long overdue. Opponents worry about the cost and the timing.",
  "A spokesperson declined to give exact figures but said the budget had already been approved.",
  "Experts we spoke to described the move as a small step that could still make a real difference.",
  "The first results are expected before the end of the year, when a full report will be presented.",
  "Similar projects in other cities have had mixed results, according to a recent study.",
  "For now, little will change in daily life, but more announcements are expected soon.",
  "Local groups plan to hold an open meeting next week to discuss what happens next.",
];
const UPDATE_PARAGRAPHS = [
  "Update: officials have since confirmed the timetable and published the full figures.",
  "Update: after this article was first published, the committee added two more meetings.",
  "Update: a spokesperson has now responded to our questions; the answers are included above.",
];
const EDITOR_NOTES = [
  "Please add a second source for the numbers in the third paragraph.",
  "The title is too long for the front page. Can you shorten it?",
  "Who is the spokesperson? Please add their name and role.",
  "The summary repeats the title. Please write one sentence that adds information.",
  "Check the dates: the meeting was on Tuesday, not Monday.",
  "Please add a quote from someone who disagrees.",
];

/**
 * A small seeded random number generator (mulberry32), so every run builds the same articles.
 * @param {number} seed Any whole number.
 * @returns {Function} random() returning a number from 0 (inclusive) to 1 (exclusive).
 * @example const random = createRandom(42);
 */
function createRandom(seed) {
  let state = seed >>> 0;
  return function random() {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Picks one item of a list.
 * @param {Function} random The random generator.
 * @param {Array} list The list.
 * @returns {*} One item.
 * @example pick(random, PLACES)
 */
function pick(random, list) {
  return list[Math.floor(random() * list.length)];
}

/**
 * A whole number in a range.
 * @param {Function} random The random generator.
 * @param {number} min Smallest value.
 * @param {number} max Largest value (included).
 * @returns {number} The number.
 * @example between(random, 1, 60)
 */
function between(random, min, max) {
  return min + Math.floor(random() * (max - min + 1));
}

/**
 * Shuffles a list in place (Fisher-Yates).
 * @param {Function} random The random generator.
 * @param {Array} list The list.
 * @returns {Array} The same list.
 * @example shuffle(random, states)
 */
function shuffle(random, list) {
  for (let index = list.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [list[index], list[other]] = [list[other], list[index]];
  }
  return list;
}

/**
 * Builds the content fields of one article.
 * @param {Function} random The random generator.
 * @param {string} category One of ARTICLE_CATEGORIES.
 * @returns {Object} { title, summary, content, imageUrl, category }. imageUrl is empty: C's feed then shows its
 *   own placeholder block, and the article page shows no image.
 * @example buildContentFields(random, "Sports")
 */
function buildContentFields(random, category) {
  const words = TITLE_WORDS[category];
  let title = `${pick(random, words.subjects)} ${pick(random, words.actions)} ${pick(random, words.objects)}`;
  if (random() < 0.5) {
    title += ` in ${pick(random, PLACES)}`;
  }
  const paragraphs = shuffle(random, [...PARAGRAPHS]).slice(0, between(random, 2, 4));
  return {
    title,
    summary: `${title}. ${pick(random, SUMMARY_ENDINGS)}`,
    content: [`${title}, The Daily Web has learned.`, ...paragraphs].join("\n\n"),
    imageUrl: "",
    category,
  };
}

/**
 * A newer version of published content, as a reporter's revision would look.
 * @param {Function} random The random generator.
 * @param {Object} content The published content fields.
 * @returns {Object} The changed copy: title marked as updated and one update paragraph added.
 * @example revisedContent(random, published)
 */
function revisedContent(random, content) {
  return {
    ...content,
    title: `${content.title} (updated)`,
    content: `${content.content}\n\n${pick(random, UPDATE_PARAGRAPHS)}`,
  };
}

/**
 * The public version, built the same way articleService.approve() builds it.
 * @param {Object} content The approved content fields.
 * @param {string} authorName The author's name.
 * @param {Date} publishedAt First approval.
 * @param {Date} updatedAt Latest approval.
 * @returns {Object} The `approved` sub-document.
 * @example approvedVersion(content, "Noa Levi", firstDate, lastDate)
 */
function approvedVersion(content, authorName, publishedAt, updatedAt) {
  const { title, summary, content: text, imageUrl, category } = content;
  return { title, summary, content: text, imageUrl, category, authorName, publishedAt, updatedAt };
}

/**
 * Builds one article document in the given state.
 * @param {Object} options
 * @param {string} options.state "published", "pending", "revision", "draft" or "returned".
 * @param {string} options.category The category.
 * @param {Object} options.reporter One of REPORTERS.
 * @param {number} options.approvals For published articles: how many times it was approved (1-5).
 * @param {Function} options.random The random generator.
 * @param {number} options.now The current time in milliseconds.
 * @returns {Object} A plain article document, ready for insertMany.
 * @example buildArticle({ state: "draft", category: "Health", reporter: REPORTERS[0], approvals: 0, random, now })
 */
function buildArticle({ state, category, reporter, approvals, random, now }) {
  const content = buildContentFields(random, category);
  const base = {
    _id: new mongoose.Types.ObjectId(),
    author: new mongoose.Types.ObjectId(reporter.id),
    authorName: reporter.name,
    editorNote: "",
    publishCount: 0,
    totalViews: 0,
  };

  if (state === "published" || state === "revision") {
    // Articles with several approvals are older, so their updates fit before today.
    const firstDay = approvals > 1 ? between(random, 30, PUBLISHED_DAYS) : between(random, 1, PUBLISHED_DAYS);
    const publishedAt = new Date(now - firstDay * DAY_MS - between(random, 0, 23) * HOUR_MS);
    const daysBetweenUpdates = Math.max(1, Math.floor((firstDay - 1) / approvals));
    const lastApprovalAt = new Date(publishedAt.getTime() + (approvals - 1) * daysBetweenUpdates * DAY_MS);
    const approved = approvedVersion(content, reporter.name, publishedAt, lastApprovalAt);
    const createdAt = new Date(publishedAt.getTime() - between(random, 2, 48) * HOUR_MS);

    if (state === "published") {
      // After approval the working copy equals the public version (as approve() leaves it).
      return { ...base, status: "published", draft: content, approved, publishCount: approvals, createdAt, updatedAt: lastApprovalAt };
    }
    // A newer version was submitted after the last approval and waits for an editor.
    const submittedAt = new Date(Math.max(lastApprovalAt.getTime() + HOUR_MS, now - between(random, 1, 72) * HOUR_MS));
    return {
      ...base,
      status: "pending",
      draft: revisedContent(random, content),
      approved,
      publishCount: approvals,
      createdAt,
      updatedAt: submittedAt,
    };
  }

  const createdAt = new Date(now - between(random, 1, 20) * DAY_MS);
  const updatedAt = new Date(Math.min(now, createdAt.getTime() + between(random, 1, 72) * HOUR_MS));
  if (state === "pending") {
    return { ...base, status: "pending", draft: content, createdAt, updatedAt };
  }
  if (state === "returned") {
    return { ...base, status: "returned", draft: content, editorNote: pick(random, EDITOR_NOTES), createdAt, updatedAt };
  }
  // Drafts: half are complete, half are half written (only a title and an opening, as autosave leaves them).
  const draft =
    random() < 0.5 ? content : { ...content, summary: "", content: content.content.split("\n\n")[0], category: random() < 0.5 ? category : "" };
  return { ...base, status: "draft", draft, createdAt, updatedAt };
}

/**
 * Builds all seed articles. Same seed, same articles (only the dates move with `now`).
 * Categories and reporters are combined evenly, so every category has articles of every reporter;
 * the states are shuffled over them.
 * @param {{ now?: Date, seed?: number }} [options] The current time and the random seed.
 * @returns {Object[]} ARTICLE_COUNT plain article documents.
 * @example const articles = buildSeedArticles();
 */
function buildSeedArticles({ now = new Date(), seed = 42 } = {}) {
  const random = createRandom(seed);
  const states = shuffle(random, STATE_PLAN.flatMap(([state, count]) => Array(count).fill(state)));
  let multiUpdatesLeft = MULTI_UPDATE_COUNT;

  return states.map((state, index) => {
    let approvals = state === "published" || state === "revision" ? 1 : 0;
    if (state === "published" && multiUpdatesLeft > 0) {
      approvals = between(random, 2, 5);
      multiUpdatesLeft -= 1;
    }
    return buildArticle({
      state,
      category: ARTICLE_CATEGORIES[index % ARTICLE_CATEGORIES.length],
      reporter: REPORTERS[Math.floor(index / ARTICLE_CATEGORIES.length) % REPORTERS.length],
      approvals,
      random,
      now: now.getTime(),
    });
  });
}

/**
 * Prints what is in the database after seeding.
 * @returns {Promise<void>}
 * @example await printSummary();
 */
async function printSummary() {
  const [byStatus, byCategory, revisions, multiUpdates] = await Promise.all([
    Article.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }, { $sort: { _id: 1 } }]),
    Article.aggregate([{ $group: { _id: "$draft.category", count: { $sum: 1 } } }, { $sort: { _id: 1 } }]),
    Article.countDocuments({ status: "pending", ...Article.publicFilter() }),
    Article.countDocuments({ publishCount: { $gte: 2 } }),
  ]);
  console.log(`\nSeeded ${await Article.countDocuments()} articles.`);
  console.log("By status:", byStatus.map((row) => `${row._id} ${row.count}`).join(", "));
  console.log(`  of the pending ones, ${revisions} are new versions of published articles`);
  console.log("By category:", byCategory.map((row) => `${row._id || "(none yet)"} ${row.count}`).join(", "));
  console.log(`Public (have an approved version): ${await Article.countDocuments(Article.publicFilter())}`);
  console.log(`Approved 2-5 times (publishCount >= 2): ${multiUpdates}`);
  console.log("Reporters (no user accounts yet; created when A's User model exists):");
  for (const reporter of REPORTERS) {
    console.log(`  ${reporter.name}  id ${reporter.id}`);
  }
}

/**
 * Replaces all articles with the seed articles.
 * @returns {Promise<void>} Resolves when done.
 * @throws {Error} With NODE_ENV=production, without MONGODB_URI, or when a document fails validation.
 * @example Run with `npm run seed`.
 */
async function seed() {
  dotenv.config({ quiet: true });
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to seed: NODE_ENV is production.");
  }
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is not set. Add it to .env (see .env.example).");
  }
  await mongoose.connect(process.env.MONGODB_URI);
  console.warn(`WARNING: deleting ALL articles in database "${mongoose.connection.name}" and creating ${ARTICLE_COUNT} new ones.`);
  console.warn("Comments, read history, views and publish events are not touched.");

  await Article.init();
  // Built before deleting, so a bug in the generator never leaves the collection empty.
  const articles = buildSeedArticles();
  await Article.deleteMany({});
  // insertMany validates every document against the model. The dates are set by the seed, not "now".
  await Article.insertMany(articles, { timestamps: false });
  await printSummary();
}

if (require.main === module) {
  seed()
    .catch((error) => {
      console.error(`Seed failed: ${error.message}`);
      process.exitCode = 1;
    })
    .finally(() => mongoose.disconnect());
}

module.exports = { buildSeedArticles, REPORTERS, ARTICLE_COUNT, STATE_PLAN, MULTI_UPDATE_COUNT };
