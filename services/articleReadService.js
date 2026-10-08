// Read history per device. Uses the default mongoose connection of the application.

const ArticleRead = require("../models/ArticleRead");
const { isValidDeviceId } = require("../middleware/deviceIdentity");

// The caller must already have found the article in the public (approved) set.
// Upsert on the unique (deviceId, articleId) key: repeated or simultaneous visits keep one record.
async function markArticleRead(deviceId, articleId) {
  if (!isValidDeviceId(deviceId)) {
    throw new Error("markArticleRead needs a valid device id.");
  }
  await ArticleRead.updateOne(
    { deviceId, articleId },
    { $set: { readAt: new Date() } },
    { upsert: true }
  );
}

// Ids of every article this device has opened. The query is covered by the unique index.
// Errors are not caught: a filtered feed must fail instead of silently ignoring the history.
async function getReadArticleIds(deviceId) {
  if (!isValidDeviceId(deviceId)) {
    throw new Error("getReadArticleIds needs a valid device id.");
  }
  const records = await ArticleRead.find({ deviceId }).select({ articleId: 1, _id: 0 }).lean();
  return records.map((record) => record.articleId);
}

module.exports = { markArticleRead, getReadArticleIds };
