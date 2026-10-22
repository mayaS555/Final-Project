// Development seed (owned by B): replaces all articles with 500 generated ones in every workflow state.
// Run with `npm run seed`. Reads MONGODB_URI from .env, refuses to run when NODE_ENV=production, and replaces
// the demo collections that depend on those articles: comments, read history, article views and publish events.
// It also creates/updates five reporter accounts and one editor through A's User model, so the seeded articles
// belong to real users. Other accounts and other users' data are not touched.
// The documents have exactly the shape articleService gives real articles: working copy (draft) + public version.

const mongoose = require("mongoose");
const dotenv = require("dotenv");
const Article = require("../models/Article");
const ArticleRead = require("../models/ArticleRead");
const ArticleView = require("../models/ArticleView");
const Comment = require("../models/Comment");
const PublishEvent = require("../models/PublishEvent");
const User = require("../models/User");
const { ARTICLE_CATEGORIES } = require("../models/articleCategories");

const ARTICLE_COUNT = 500;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// Published dates are spread over this many days before the seed runs.
const PUBLISHED_DAYS = 60;
// How many published articles get 2-5 approvals, for D's before/after analytics.
const MULTI_UPDATE_COUNT = 15;
// Default demo passwords. `npm run seed` uses SEED_REPORTER_PASSWORD / SEED_EDITOR_PASSWORD when they are set.
const DEFAULT_REPORTER_PASSWORD = "reporter123";
const DEFAULT_EDITOR_PASSWORD = "editor123";

// The demo staff accounts. They are created through the User model, so the password is hashed by its pre-save hook.
// The reporters keep the stable ids the seed used before real users existed, so any external check or bookmark that
// knows those ids still finds a real User document. The editor gets a normal generated id.
const REPORTERS = [
  { id: "665000000000000000000001", name: "Noa Levi", email: "noa.levi@dailyweb.test" },
  { id: "665000000000000000000002", name: "Daniel Cohen", email: "daniel.cohen@dailyweb.test" },
  { id: "665000000000000000000003", name: "Yael Mizrahi", email: "yael.mizrahi@dailyweb.test" },
  { id: "665000000000000000000004", name: "Omer Friedman", email: "omer.friedman@dailyweb.test" },
  { id: "665000000000000000000005", name: "Maya Shapiro", email: "maya.shapiro@dailyweb.test" },
];
const EDITOR = { name: "Ruth Adler", email: "editor@dailyweb.test" };

// Reader comments. The seed uses them on public articles so the demo has a populated comments section.
const COMMENTERS = ["Michal", "Avi", "Sara", "Yossi", "Tamar", "Eli", "Nina", "Omar"];
const COMMENT_BODIES = [
  "Thanks for the clear reporting.",
  "Does anyone know when this will reach the city center?",
  "I live nearby and can confirm this is a big issue.",
  "The numbers in the article would be easier to understand in a table.",
  "Good to see the paper following this story.",
  "What happened to the earlier plan?",
  "Please keep us updated on the next meeting.",
  "A second source would make this stronger.",
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
 * The reporters used by buildSeedArticles() when no real users are passed. The ids are the same stable ids the seed
 * uses for the accounts, so offline tests and the database see the same authors.
 * @returns {Object[]} REPORTERS, each with an `id`.
 * @example const reporters = defaultReporters();
 */
function defaultReporters() {
  return REPORTERS;
}

/**
 * Builds all seed articles. Same seed, same articles (only the dates move with `now`).
 * Categories and reporters are combined evenly, so every category has articles of every reporter;
 * the states are shuffled over them.
 * @param {{ now?: Date, seed?: number, reporters?: Object[] }} [options] The current time, the random seed and
 *   the reporters ({ id, name }) that own the articles.
 * @returns {Object[]} ARTICLE_COUNT plain article documents.
 * @example const articles = buildSeedArticles();
 */
function buildSeedArticles({ now = new Date(), seed = 42, reporters = defaultReporters() } = {}) {
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
      reporter: reporters[Math.floor(index / ARTICLE_CATEGORIES.length) % reporters.length],
      approvals,
      random,
      now: now.getTime(),
    });
  });
}

/**
 * Builds reader comments for the public articles.
 * @param {{ articles: Object[], now?: Date, seed?: number }} options The generated articles, the current time and
 *   the random seed.
 * @returns {Object[]} Plain Comment documents, with dates after publication and before `now`.
 * @example const comments = buildSeedComments({ articles });
 */
function buildSeedComments({ articles, now = new Date(), seed = 77 } = {}) {
  const random = createRandom(seed);
  const comments = [];

  for (const article of articles.filter((item) => item.approved)) {
    // A few articles stay without comments, as on a real site.
    if (random() < 0.2) {
      continue;
    }
    const publishedAt = article.approved.publishedAt.getTime();
    const availableMs = Math.max(HOUR_MS, now.getTime() - publishedAt);
    const count = between(random, 1, 4);
    for (let index = 0; index < count; index += 1) {
      const createdAt = new Date(publishedAt + Math.floor(random() * availableMs));
      comments.push({
        articleId: article._id,
        deviceId: `seed-device-${between(random, 1, 40)}`,
        displayName: pick(random, COMMENTERS),
        body: pick(random, COMMENT_BODIES),
        createdAt,
        updatedAt: createdAt,
      });
    }
  }
  return comments;
}

/**
 * The start of the UTC day of a date. View buckets are daily so the seed stays small and the chart can sum them.
 * @param {Date} date Any date.
 * @returns {Date} A new date at 00:00 UTC of that day.
 * @example startOfUtcDay(new Date("2026-10-19T15:30:00Z")) // 2026-10-19T00:00:00Z
 */
function startOfUtcDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * Builds the analytics demo data: daily view buckets and one publish event per approval.
 * Views start on the publication day, decay over time, and spike on days when a new version was published.
 * @param {{ articles: Object[], now?: Date, seed?: number }} options The generated articles, the current time and
 *   the random seed.
 * @returns {{ views: Object[], publishEvents: Object[], totalViews: Map<string, number> }} Plain documents for
 *   the ArticleView and PublishEvent models, and the matching total per article id.
 * @example const { views, publishEvents, totalViews } = buildSeedAnalytics({ articles });
 */
function buildSeedAnalytics({ articles, now = new Date(), seed = 2026 } = {}) {
  const random = createRandom(seed);
  const views = [];
  const publishEvents = [];
  const totalViews = new Map();

  for (const article of articles.filter((item) => item.approved)) {
    const articleId = article._id;
    const firstPublish = article.approved.publishedAt;
    const lastPublish = article.approved.updatedAt;
    const approvals = Math.max(1, article.publishCount || 1);

    // Publish events, evenly spread between the first and the latest approval. The first and last dates match
    // approved.publishedAt and approved.updatedAt, so the markers line up with the article history.
    const eventTimes = [];
    for (let index = 0; index < approvals; index += 1) {
      const ratio = approvals === 1 ? 0 : index / (approvals - 1);
      eventTimes.push(new Date(firstPublish.getTime() + (lastPublish.getTime() - firstPublish.getTime()) * ratio));
    }
    eventTimes.forEach((publishedAt, index) => {
      publishEvents.push({
        articleId,
        publishedAt,
        publishCount: index + 1,
        isFirstPublish: index === 0,
      });
    });

    // One bucket per day from publication until today. Most articles have a small steady readership; an update
    // brings a spike, which is what the Impact Analytics graph is meant to show.
    const firstDay = startOfUtcDay(firstPublish);
    const eventDays = new Set(eventTimes.map((date) => startOfUtcDay(date).getTime()));
    const popularity = between(random, 40, 260);
    let total = 0;
    for (let day = firstDay; day.getTime() <= now.getTime(); day = new Date(day.getTime() + DAY_MS)) {
      const ageDays = (day.getTime() - firstDay.getTime()) / DAY_MS;
      const decay = Math.exp(-ageDays / 16);
      let count = Math.max(1, Math.round(popularity * decay * (0.6 + random() * 0.8)));
      if (eventDays.has(day.getTime())) {
        count += between(random, popularity, popularity * 3);
      }
      if (random() < 0.04) {
        count *= 2;
      }
      views.push({ articleId, bucketStart: new Date(day), count });
      total += count;
    }
    totalViews.set(String(articleId), total);
  }

  return { views, publishEvents, totalViews };
}

/**
 * Creates a demo account or updates its name, role and password. The User pre-save hook hashes the password.
 * @param {{ id?: string, name: string, email: string, role: string, password: string }} account The account fields.
 * @returns {Promise<Object>} The saved User document.
 * @example await upsertSeedUser({ name: "Noa Levi", email: "noa@example.test", role: "reporter", password: "secret" });
 */
async function upsertSeedUser({ id, name, email, role, password }) {
  const normalizedEmail = email.toLowerCase();
  const existing = (await User.findOne({ email: normalizedEmail })) || (id ? await User.findById(id) : null);
  if (existing) {
    existing.name = name;
    existing.email = normalizedEmail;
    existing.role = role;
    existing.password = password; // hashed by the pre-save hook
    return existing.save();
  }
  const fields = { name, email: normalizedEmail, role, password };
  if (id) {
    fields._id = id;
  }
  return User.create(fields);
}

/**
 * Creates/updates the five demo reporters and the demo editor.
 * @returns {Promise<{ reporters: Object[], editor: Object }>} The saved user documents, with real ids.
 * @example const { reporters, editor } = await createSeedUsers();
 */
async function createSeedUsers() {
  const reporterPassword = process.env.SEED_REPORTER_PASSWORD || DEFAULT_REPORTER_PASSWORD;
  const editorPassword = process.env.SEED_EDITOR_PASSWORD || DEFAULT_EDITOR_PASSWORD;
  const reporters = [];
  for (const reporter of REPORTERS) {
    reporters.push(await upsertSeedUser({ ...reporter, role: "reporter", password: reporterPassword }));
  }
  const editor = await upsertSeedUser({ ...EDITOR, role: "editor", password: editorPassword });
  return { reporters, editor };
}

/**
 * Prints what is in the database after seeding.
 * @param {{ reporters: Object[], editor: Object }} users The demo accounts that were created.
 * @returns {Promise<void>}
 * @example await printSummary({ reporters, editor });
 */
async function printSummary({ reporters, editor }) {
  const [byStatus, byCategory, revisions, multiUpdates, comments, viewBuckets, publishEvents, viewedArticles] = await Promise.all([
    Article.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }, { $sort: { _id: 1 } }]),
    Article.aggregate([{ $group: { _id: "$draft.category", count: { $sum: 1 } } }, { $sort: { _id: 1 } }]),
    Article.countDocuments({ status: "pending", ...Article.publicFilter() }),
    Article.countDocuments({ publishCount: { $gte: 2 } }),
    Comment.countDocuments(),
    ArticleView.countDocuments(),
    PublishEvent.countDocuments(),
    ArticleView.aggregate([{ $group: { _id: null, count: { $sum: "$count" } } }]),
  ]);
  console.log(`\nSeeded ${await Article.countDocuments()} articles.`);
  console.log("By status:", byStatus.map((row) => `${row._id} ${row.count}`).join(", "));
  console.log(`  of the pending ones, ${revisions} are new versions of published articles`);
  console.log("By category:", byCategory.map((row) => `${row._id || "(none yet)"} ${row.count}`).join(", "));
  console.log(`Public (have an approved version): ${await Article.countDocuments(Article.publicFilter())}`);
  console.log(`Approved 2-5 times (publishCount >= 2): ${multiUpdates}`);
  console.log(`Comments: ${comments}`);
  console.log(`View buckets: ${viewBuckets} (${viewedArticles[0] ? viewedArticles[0].count : 0} total views)`);
  console.log(`Publish events: ${publishEvents}`);
  console.log("Demo staff accounts (password from SEED_REPORTER_PASSWORD / SEED_EDITOR_PASSWORD):");
  for (const reporter of reporters) {
    console.log(`  reporter  ${reporter.email}  ${reporter.name}`);
  }
  console.log(`  editor    ${editor.email}  ${editor.name}`);
}

/**
 * Replaces all articles and the demo data that depends on them, and creates/updates the demo staff accounts.
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
  const connectOptions = process.env.DB_NAME ? { dbName: process.env.DB_NAME } : {};
  await mongoose.connect(process.env.MONGODB_URI, connectOptions);
  console.warn(
    `WARNING: deleting ALL articles, comments, read history, article views and publish events in database ` +
      `"${mongoose.connection.name}", then creating ${ARTICLE_COUNT} new articles.`
  );
  console.warn("Demo reporter and editor accounts are created or updated; other users are not touched.");

  await Promise.all([
    Article.init(),
    ArticleRead.init(),
    ArticleView.init(),
    Comment.init(),
    PublishEvent.init(),
    User.init(),
  ]);

  // Real accounts first, so every article has a valid author in the User collection.
  const { reporters, editor } = await createSeedUsers();
  const seedReporters = reporters.map((user) => ({ id: String(user._id), name: user.name }));

  // Built before deleting, so a bug in the generator never leaves the collections empty.
  const articles = buildSeedArticles({ reporters: seedReporters });
  const analytics = buildSeedAnalytics({ articles });
  for (const article of articles) {
    article.totalViews = analytics.totalViews.get(String(article._id)) || 0;
  }
  const comments = buildSeedComments({ articles });

  await Promise.all([
    Article.deleteMany({}),
    ArticleRead.deleteMany({}),
    ArticleView.deleteMany({}),
    Comment.deleteMany({}),
    PublishEvent.deleteMany({}),
  ]);

  // insertMany validates every document against the model. The dates are set by the seed, not "now".
  await Article.insertMany(articles, { timestamps: false });
  if (comments.length > 0) {
    await Comment.insertMany(comments, { timestamps: false });
  }
  if (analytics.views.length > 0) {
    await ArticleView.insertMany(analytics.views);
  }
  if (analytics.publishEvents.length > 0) {
    await PublishEvent.insertMany(analytics.publishEvents);
  }
  await printSummary({ reporters, editor });
}

if (require.main === module) {
  seed()
    .catch((error) => {
      console.error(`Seed failed: ${error.message}`);
      process.exitCode = 1;
    })
    .finally(() => mongoose.disconnect());
}

module.exports = {
  buildSeedArticles,
  buildSeedAnalytics,
  buildSeedComments,
  createSeedUsers,
  REPORTERS,
  EDITOR,
  ARTICLE_COUNT,
  STATE_PLAN,
  MULTI_UPDATE_COUNT,
};
