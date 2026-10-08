// Anonymous device identity for the public site (owned by C).
// The cookie holds a random opaque id. It is NOT authentication and grants no role:
// clearing cookies creates a new identity, and each browser has its own history.
// The id is read only from the Cookie header, never from the query string or the body.

const crypto = require("crypto");

const DEVICE_COOKIE_NAME = "dw_device";
// One year, counted from the moment the cookie is issued (it is not renewed on later visits).
const DEVICE_COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

// 16 random bytes as 32 lowercase hex characters.
const DEVICE_ID_PATTERN = /^[0-9a-f]{32}$/;

function isValidDeviceId(value) {
  return typeof value === "string" && DEVICE_ID_PATTERN.test(value);
}

// Reads the cookie by hand instead of adding cookie-parser. The value is checked against a
// fixed pattern and never decoded, so a malformed percent-encoding cannot throw.
function readDeviceIdCookie(cookieHeader) {
  if (typeof cookieHeader !== "string") {
    return null;
  }
  for (const part of cookieHeader.split(";")) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }
    if (part.slice(0, separatorIndex).trim() === DEVICE_COOKIE_NAME) {
      const value = part.slice(separatorIndex + 1).trim();
      return isValidDeviceId(value) ? value : null;
    }
  }
  return null;
}

function createDeviceId() {
  return crypto.randomBytes(16).toString("hex");
}

// Sets req.deviceId. Reuses a valid cookie, otherwise issues a new one in this response.
function deviceIdentity(req, res, next) {
  const existingId = readDeviceIdCookie(req.headers.cookie);
  if (existingId) {
    req.deviceId = existingId;
    next();
    return;
  }

  req.deviceId = createDeviceId();
  res.cookie(DEVICE_COOKIE_NAME, req.deviceId, {
    maxAge: DEVICE_COOKIE_MAX_AGE_MS,
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    // req.secure is true over HTTPS (behind a proxy only if A sets "trust proxy"),
    // so plain-HTTP local development still receives the cookie.
    secure: req.secure,
  });
  next();
}

module.exports = {
  deviceIdentity,
  readDeviceIdCookie,
  isValidDeviceId,
  DEVICE_COOKIE_NAME,
  DEVICE_COOKIE_MAX_AGE_MS,
};
