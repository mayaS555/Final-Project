// express-session store that keeps each login session inside its user document (User.sessions), so the
// database has no separate sessions collection. Only logged-in sessions are stored: saveUninitialized is false
// and the only session field is req.session.user, so a session without a user is never kept.
// Deleting a user also ends that user's sessions.

const session = require("express-session");
const User = require("../models/User");

class UserSessionStore extends session.Store {
  /**
   * @param {{ ttlMs: number }} options Lifetime of a session without a cookie expiry date.
   */
  constructor({ ttlMs }) {
    super();
    this.ttlMs = ttlMs;
  }

  get(sid, callback) {
    User.findOne({ "sessions.sid": sid }, { sessions: { $elemMatch: { sid } } })
      .lean()
      .then((user) => {
        const stored = user?.sessions?.[0];
        callback(
          null,
          stored && stored.expiresAt > new Date()
            ? JSON.parse(stored.data)
            : null,
        );
      }, callback);
  }

  set(sid, sess, callback) {
    const userId = sess.user?._id;
    if (!userId) {
      this.destroy(sid, callback);
      return;
    }
    const now = new Date();
    const expiresAt = sess.cookie?.expires
      ? new Date(sess.cookie.expires)
      : new Date(now.getTime() + this.ttlMs);
    // Removes this sid from whichever user had it, and the user's expired sessions, then adds the new one.
    // timestamps: false keeps logins from changing the user's updatedAt.
    User.updateMany(
      { $or: [{ "sessions.sid": sid }, { _id: userId }] },
      { $pull: { sessions: { $or: [{ sid }, { expiresAt: { $lte: now } }] } } },
      { timestamps: false },
    )
      .then(() =>
        User.updateOne(
          { _id: userId },
          {
            $push: { sessions: { sid, data: JSON.stringify(sess), expiresAt } },
          },
          { timestamps: false },
        ),
      )
      .then(() => callback(null), callback);
  }

  destroy(sid, callback) {
    User.updateOne(
      { "sessions.sid": sid },
      { $pull: { sessions: { sid } } },
      { timestamps: false },
    ).then(() => callback(null), callback);
  }
}

module.exports = UserSessionStore;
