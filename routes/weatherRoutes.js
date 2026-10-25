"use strict";

const express = require("express");
const weatherService = require("../services/weatherService");

const router = express.Router();

/**
 * GET /api/weather
 *
 * Query params:
 *   city   - city name (default: WEATHER_DEFAULT_CITY env var, or "Tel Aviv")
 *   units  - "metric" | "imperial" | "standard"  (default: "metric")
 *
 * Response shape:
 *   { data, fromCache, stale, unavailable }
 */
router.get("/api/weather", async (req, res) => {
  const apiKey = process.env.OPENWEATHERMAP_API_KEY;
  if (!apiKey) {
    return res.status(503).json({
      data: null,
      fromCache: false,
      stale: false,
      unavailable: true,
      error: "Weather service is not configured.",
    });
  }

  const city =
    (typeof req.query.city === "string" && req.query.city.trim()) ||
    process.env.WEATHER_DEFAULT_CITY ||
    "Tel Aviv";

  const units = ["metric", "imperial", "standard"].includes(req.query.units)
    ? req.query.units
    : "metric";

  const result = await weatherService.getWeather(city, apiKey, units);

  // Cache-Control: the route has its own TTL so CDN/browser caches are safe to
  // use for up to the remaining cache lifetime.  We use a conservative 60 s
  // public TTL so clients re-check often while the server cache absorbs load.
  res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=840");
  res.json(result);
});

module.exports = router;
