// Adds the header weather to res.locals for staff pages.

const weatherService = require("../services/weatherService");

async function loadWeather(req, res, next) {
  res.locals.weather = await weatherService.getWeatherForWidget();
  next();
}

module.exports = { loadWeather };
