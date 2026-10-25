const { describe, test, mock } = require("node:test");
const assert = require("node:assert/strict");
const weatherService = require("../services/weatherService");
const { loadWeather } = require("../middleware/weatherWidget");

describe("loadWeather", () => {
  test("puts the widget reading into res.locals and continues", async () => {
    const reading = {
      data: { city: "Tel Aviv", country: "IL", temp: 25 },
      fromCache: false,
      stale: false,
      unavailable: false,
    };
    mock.method(weatherService, "getWeatherForWidget", async () => reading);

    const res = { locals: {} };
    let nextCalled = false;

    try {
      await loadWeather({}, res, () => {
        nextCalled = true;
      });
    } finally {
      mock.restoreAll();
    }

    assert.equal(res.locals.weather, reading);
    assert.equal(nextCalled, true);
  });

  test("continues without weather when the lookup fails", async () => {
    mock.method(weatherService, "getWeatherForWidget", async () => {
      throw new Error("weather service is down");
    });

    const res = { locals: {} };
    let nextCalled = false;

    try {
      await loadWeather({}, res, () => {
        nextCalled = true;
      });
    } finally {
      mock.restoreAll();
    }

    // A weather failure must not turn an editor page into an error page.
    assert.equal(res.locals.weather, null);
    assert.equal(nextCalled, true);
  });
});
