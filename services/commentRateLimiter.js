// At most `limit` new comments per device in any rolling window (default 3 per 60 seconds),
// counted across all articles.
//
// Limitations (acceptable for one Express process, not for several):
// - the counters live in memory, so they reset when the server restarts;
// - each server process has its own counters;
// - the device is an anonymous cookie, so clearing cookies gives a new device and a new quota.
//
// reserve() checks and takes a slot in one synchronous step, before the caller awaits the database
// write. Simultaneous requests therefore cannot all pass the check. If the write fails the caller
// must call release() so the failed attempt does not use up a slot.

const DEFAULT_LIMIT = 3;
const DEFAULT_WINDOW_MS = 60 * 1000;

// `now` can be replaced in tests so the window can be tested without waiting.
function createCommentRateLimiter({ limit = DEFAULT_LIMIT, windowMs = DEFAULT_WINDOW_MS, now = Date.now } = {}) {
  // deviceId -> list of reservations, each { time }. A device has at most `limit` live entries.
  const reservationsByDevice = new Map();
  let lastSweepTime = now();

  function liveReservations(deviceId, currentTime) {
    const reservations = reservationsByDevice.get(deviceId) || [];
    return reservations.filter((reservation) => reservation.time > currentTime - windowMs);
  }

  // Drops devices whose reservations have all expired, at most once per window,
  // so the map does not keep every device that ever posted.
  function sweepExpiredDevices(currentTime) {
    if (currentTime - lastSweepTime < windowMs) {
      return;
    }
    lastSweepTime = currentTime;
    for (const deviceId of [...reservationsByDevice.keys()]) {
      const live = liveReservations(deviceId, currentTime);
      if (live.length === 0) {
        reservationsByDevice.delete(deviceId);
      } else {
        reservationsByDevice.set(deviceId, live);
      }
    }
  }

  // Returns { allowed: true, release } or { allowed: false, retryAfterSeconds }.
  function reserve(deviceId) {
    const currentTime = now();
    sweepExpiredDevices(currentTime);

    const live = liveReservations(deviceId, currentTime);
    if (live.length >= limit) {
      reservationsByDevice.set(deviceId, live);
      const oldestTime = Math.min(...live.map((reservation) => reservation.time));
      const retryAfterSeconds = Math.max(1, Math.ceil((oldestTime + windowMs - currentTime) / 1000));
      return { allowed: false, retryAfterSeconds };
    }

    const reservation = { time: currentTime };
    live.push(reservation);
    reservationsByDevice.set(deviceId, live);

    // Removes exactly this reservation. Calling it again does nothing.
    function release() {
      const reservations = reservationsByDevice.get(deviceId);
      if (!reservations) {
        return;
      }
      const index = reservations.indexOf(reservation);
      if (index !== -1) {
        reservations.splice(index, 1);
      }
      if (reservations.length === 0) {
        reservationsByDevice.delete(deviceId);
      }
    }
    return { allowed: true, release };
  }

  function trackedDeviceCount() {
    return reservationsByDevice.size;
  }

  return { reserve, trackedDeviceCount, limit, windowMs };
}

// The instance used by the application.
const commentRateLimiter = createCommentRateLimiter();

module.exports = { createCommentRateLimiter, commentRateLimiter };
