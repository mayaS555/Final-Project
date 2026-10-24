const Article = require("../models/Article");
const { createHttpError } = require("./articleStatus");

const DAY = 86400000;
const RESOLUTIONS = { minute: 60000, hour: 3600000, day: DAY };
const floorDay = (date) => new Date(Math.floor(date.getTime() / DAY) * DAY);

// One bucket per article/day inside Article.views, at most 1440 minute counters in that bucket.
// Concurrent readers use atomic single-document updates, never a read/modify/save counter, so the bucket and
// totalViews always change together. timestamps:false keeps visits from changing the editorial updatedAt.
async function recordArticleView(articleId, now = new Date()) {
  const bucketStart = floorDay(now);
  const minute = Math.floor((now.getTime() - bucketStart.getTime()) / 60000);
  const visible = { _id: articleId, ...Article.publicFilter() };
  for (let attempt = 0; attempt < 2; attempt++) {
    const increased = await Article.updateOne(
      { ...visible, "views.bucketStart": bucketStart },
      { $inc: { totalViews: 1, "views.$.count": 1, [`views.$.minuteCounts.${minute}`]: 1 } },
      { timestamps: false }
    );
    if (increased.matchedCount) return;
    // First visit of the day. The $ne guard stops two simultaneous first visits from adding two buckets.
    const added = await Article.updateOne(
      { ...visible, "views.bucketStart": { $ne: bucketStart } },
      { $inc: { totalViews: 1 }, $push: { views: { bucketStart, count: 1, minuteCounts: { [minute]: 1 } } } },
      { timestamps: false }
    );
    if (added.matchedCount) return;
    // Not public (nothing to count), or another visit just added today's bucket: increase that one instead.
  }
}

function parseRange(query, now = new Date()) {
  const resolution = query.resolution === undefined ? "day" : query.resolution;
  if (typeof resolution !== "string" || !Object.hasOwn(RESOLUTIONS, resolution)) {
    throw createHttpError(400, "resolution must be minute, hour or day.");
  }
  function dateValue(raw, fallback) {
    if (raw === undefined || raw === "") return fallback;
    if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{3})?)?Z$/.test(raw)) {
      throw createHttpError(400, "Dates must be single ISO timestamps in UTC.");
    }
    const value = new Date(raw);
    if (!Number.isFinite(value.getTime()) || value.toISOString().slice(0, 16) !== raw.slice(0, 16)) {
      throw createHttpError(400, "Invalid date.");
    }
    return value;
  }
  const to = dateValue(query.to, now);
  const from = dateValue(query.from, new Date(to.getTime() - 30 * DAY));
  const step = RESOLUTIONS[resolution];
  if (from >= to || to - from > 366 * DAY || from.getUTCFullYear() < 2000 || to.getUTCFullYear() > 2100) {
    throw createHttpError(400, "Choose a positive date range of at most 366 days.");
  }
  const start = Math.floor(from.getTime() / step) * step;
  const end = Math.ceil(to.getTime() / step) * step;
  if ((end - start) / step > 1500) throw createHttpError(400, "This range is too long for the selected resolution (maximum 1500 points).");
  return { from: new Date(start), to: new Date(end), step, resolution };
}

// Historical seed buckets contain daily totals only. Never invent an hourly distribution for them.
function buildSeries(days, range) {
  const counts = new Map();
  let dailyOnlyViews = 0;
  for (const day of days) {
    const dayStart = new Date(day.bucketStart).getTime();
    if (range.resolution === "day") {
      counts.set(dayStart, (counts.get(dayStart) || 0) + day.count);
      continue;
    }
    let detailed = 0;
    const minutes = day.minuteCounts instanceof Map ? Object.fromEntries(day.minuteCounts) : day.minuteCounts || {};
    for (const [minute, count] of Object.entries(minutes)) {
      if (!/^\d{1,4}$/.test(minute) || Number(minute) > 1439) continue;
      detailed += count;
      const timestamp = dayStart + Number(minute) * 60000;
      if (timestamp < range.from.getTime() || timestamp >= range.to.getTime()) continue;
      const bin = Math.floor(timestamp / range.step) * range.step;
      counts.set(bin, (counts.get(bin) || 0) + count);
    }
    dailyOnlyViews += Math.max(0, day.count - detailed);
  }
  const points = [];
  for (let timestamp = range.from.getTime(); timestamp < range.to.getTime(); timestamp += range.step) {
    points.push({ at: new Date(timestamp).toISOString(), views: counts.get(timestamp) || 0 });
  }
  return { points, dailyOnlyViews };
}

async function getImpact(article, range) {
  const stored = await Article.findById(article._id).select("views publishEvents").lean();
  const firstDay = floorDay(range.from);
  const days = (stored?.views || [])
    .filter((day) => day.bucketStart >= firstDay && day.bucketStart < range.to)
    .sort((first, second) => first.bucketStart - second.bucketStart);
  const events = (stored?.publishEvents || [])
    .filter((event) => event.publishedAt >= range.from && event.publishedAt < range.to)
    .sort((first, second) => first.publishedAt - second.publishedAt);
  const series = buildSeries(days, range);
  return {
    article: { id: String(article._id), title: article.draft.title || article.approved?.title || "Untitled", totalViews: article.totalViews || 0 },
    from: range.from.toISOString(), to: range.to.toISOString(), resolution: range.resolution,
    ...series,
    rangeViews: series.points.reduce((sum, point) => sum + point.views, 0),
    markers: events.map((event) => ({ at: event.publishedAt.toISOString(), version: event.publishCount, first: event.isFirstPublish })),
  };
}

// Deletion uses whole UTC days: historical data may not have minute detail.
// Unlike graph queries, deletion never silently rounds dates or supplies defaults.
function parseDeleteRange(body) {
  if (!body || Array.isArray(body) || typeof body !== "object" || body.confirm !== true) {
    throw createHttpError(400, "Confirm deletion explicitly with confirm: true.");
  }
  if (typeof body.from !== "string" || typeof body.to !== "string" || !body.from || !body.to) {
    throw createHttpError(400, "Choose an explicit start and end date for deletion.");
  }
  const range = parseRange({ from: body.from, to: body.to, resolution: "day" });
  if (new Date(body.from).getTime() !== range.from.getTime() || new Date(body.to).getTime() !== range.to.getTime()) {
    throw createHttpError(400, "Delete whole UTC days only, from midnight up to an exclusive midnight end.");
  }
  return range;
}

async function deleteViewStatistics(article, user, range) {
  const { hasEditorRole } = require("./articleStatus");
  const logger = require("./logger");
  if (!hasEditorRole(user?.role)) throw createHttpError(403, "Only editors and admins can delete view statistics.");
  // One pipeline update on one document: the buckets and totalViews change together, against fresh values.
  const inRange = { $and: [{ $gte: ["$$bucket.bucketStart", range.from] }, { $lt: ["$$bucket.bucketStart", range.to] }] };
  const deletedSum = { $sum: { $map: { input: { $filter: { input: "$views", as: "bucket", cond: inRange } }, as: "bucket", in: "$$bucket.count" } } };
  const before = await Article.findOneAndUpdate(
    { _id: article._id, $expr: { $lte: [deletedSum, { $ifNull: ["$totalViews", 0] }] } },
    [{ $set: {
      totalViews: { $subtract: [{ $ifNull: ["$totalViews", 0] }, deletedSum] },
      views: { $filter: { input: "$views", as: "bucket", cond: { $not: [inRange] } } },
    } }],
    { returnDocument: "before", timestamps: false, updatePipeline: true, projection: { views: 1, totalViews: 1 } }
  ).lean();
  if (!before) {
    if (!(await Article.exists({ _id: article._id }))) throw createHttpError(404, "Article not found.");
    throw createHttpError(409, "View counters are inconsistent. Nothing was deleted.");
  }
  const deleted = before.views.filter((bucket) => bucket.bucketStart >= range.from && bucket.bucketStart < range.to);
  const deletedViews = deleted.reduce((sum, bucket) => sum + bucket.count, 0);
  // Publication markers describe real approvals and are retained when view data is deleted.
  logger.logArticleEvent("delete_view_statistics", article._id, user._id, user.role);
  return { deletedViews, deletedBuckets: deleted.length, totalViews: (before.totalViews || 0) - deletedViews };
}

module.exports = { recordArticleView, parseRange, buildSeries, getImpact, parseDeleteRange, deleteViewStatistics };
