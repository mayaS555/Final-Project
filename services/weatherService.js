/**
 * weatherService.js
 *
 * Server-side proxy to OpenWeatherMap's "current weather" endpoint.
 * Results are cached in-memory for up to CACHE_TTL_MS (default: 15 minutes).
 * When the API is unreachable or returns an error, a stale cached value is
 * returned if one exists; otherwise a structured fallback object is returned
 * so the UI can display a graceful "weather unavailable" message.
 */

"use strict";

const https = require("https");

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

/** @type {Map<string, { data: object, fetchedAt: number, isStale: boolean }>} */
const cache = new Map();

/**
 * Performs a GET request using the built-in https module so the service has
 * zero extra dependencies.
 *
 * @param {string} url
 * @returns {Promise<object>} Parsed JSON body
 */
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 5000 }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => {
        try {
          const body = JSON.parse(raw);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(body);
          } else {
            const err = new Error(`OpenWeatherMap responded with ${res.statusCode}`);
            err.statusCode = res.statusCode;
            err.body = body;
            reject(err);
          }
        } catch (parseErr) {
          reject(new Error("Failed to parse OpenWeatherMap response as JSON"));
        }
      });
    });
    req.on("timeout", () => {
      req.destroy(new Error("OpenWeatherMap request timed out after 5 s"));
    });
    req.on("error", reject);
  });
}

/**
 * Normalises an OpenWeatherMap "current weather" response into the shape the
 * widget expects.  Only the fields the UI actually uses are kept.
 *
 * @param {object} raw - Raw OWM response body
 * @returns {object}
 */
function normalise(raw) {
  const weather = (raw.weather && raw.weather[0]) || {};
  return {
    city: raw.name || "Unknown",
    country: (raw.sys && raw.sys.country) || "",
    temp: raw.main ? Math.round(raw.main.temp) : null,
    feelsLike: raw.main ? Math.round(raw.main.feels_like) : null,
    humidity: raw.main ? raw.main.humidity : null,
    description: weather.description || "",
    icon: weather.icon || "",
    wind: raw.wind ? Math.round(raw.wind.speed) : null,
    fetchedAt: Date.now(),
    stale: false,
  };
}

/**
 * Returns the weather for the given city name.
 * Uses a 15-minute in-memory cache; falls back to stale data or a sentinel
 * object when the upstream API cannot be reached.
 *
 * @param {string} city
 * @param {string} apiKey
 * @param {string} [units="metric"]
 * @returns {Promise<{ data: object, fromCache: boolean, stale: boolean, unavailable: boolean }>}
 */
async function getWeather(city, apiKey, units = "metric") {
  const cacheKey = `${city.toLowerCase()}:${units}`;
  const now = Date.now();
  const cached = cache.get(cacheKey);

  // Return fresh cache hit immediately.
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return { data: cached.data, fromCache: true, stale: false, unavailable: false };
  }

  // Attempt a live fetch.
  const encodedCity = encodeURIComponent(city);
  const url =
    `https://api.openweathermap.org/data/2.5/weather` +
    `?q=${encodedCity}&appid=${apiKey}&units=${units}`;

  try {
    const raw = await httpGet(url);
    const data = normalise(raw);
    cache.set(cacheKey, { data, fetchedAt: now });
    return { data, fromCache: false, stale: false, unavailable: false };
  } catch (err) {
    // Fallback 1: return stale cache if we have it.
    if (cached) {
      const staleData = { ...cached.data, stale: true };
      return { data: staleData, fromCache: true, stale: true, unavailable: false };
    }

    // Fallback 2: return a sentinel so the UI shows "unavailable".
    return {
      data: {
        city,
        country: "",
        temp: null,
        feelsLike: null,
        humidity: null,
        description: "",
        icon: "",
        wind: null,
        fetchedAt: null,
        stale: false,
      },
      fromCache: false,
      stale: false,
      unavailable: true,
    };
  }
}

/** Weather for the header widget, or null when no API key is configured. */
async function getWeatherForWidget() {
  const apiKey = process.env.OPENWEATHERMAP_API_KEY;
  if (!apiKey) {
    return null;
  }
  return getWeather(process.env.WEATHER_DEFAULT_CITY || "Tel Aviv", apiKey, "metric");
}

/**
 * Clears the entire weather cache.  Exposed for unit tests.
 */
function clearCache() {
  cache.clear();
}

module.exports = { getWeather, getWeatherForWidget, clearCache };
