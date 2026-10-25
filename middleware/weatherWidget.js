// Adds the header weather to res.locals for staff pages.

const weatherService = require("../services/weatherService");
const logger = require("../services/logger");

async function loadWeather(req, res, next) {
  try {
    res.locals.weather = await weatherService.getWeatherForWidget();
  } catch (error) {
    // The widget is decorative: a weather problem must never block an editor
    // dashboard, analytics page or article page from rendering.
    logger.warn("Could not load weather for the header widget", {
      error: error instanceof Error ? error.message : String(error),
    });
    res.locals.weather = null;
  }
  next();
}

module.exports = { loadWeather };
