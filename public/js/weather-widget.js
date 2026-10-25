/**
 * weather-widget.js
 *
 * Progressively enhances the server-rendered weather widget.
 * Refreshes weather data from the server-side proxy every 15 minutes so the
 * displayed reading stays current without a full page reload.
 *
 * The server already caches responses for 15 minutes, so re-fetching on the
 * same interval keeps traffic minimal while still reflecting updates.
 */

(function () {
  "use strict";

  const REFRESH_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

  /** @returns {string} Base icon URL for the given OWM icon code. */
  function iconUrl(icon) {
    return "https://openweathermap.org/img/wn/" + icon + "@2x.png";
  }

  /**
   * Re-renders the widget contents in-place based on fresh API data.
   *
   * @param {HTMLElement} widget
   * @param {{ data: object, stale: boolean, unavailable: boolean }} result
   */
  function render(widget, result) {
    const { data, stale, unavailable } = result;

    if (unavailable || !data) {
      widget.innerHTML =
        '<span class="weather-icon weather-icon--unavail" aria-hidden="true">\uD83C\uDF2B\uFE0F</span>' +
        '<span class="weather-text weather-text--unavail">Weather unavailable</span>';
      return;
    }

    let html = "";

    if (data.icon) {
      html +=
        '<img class="weather-icon weather-icon--img"' +
        ' src="' +
        iconUrl(data.icon) +
        '"' +
        ' alt="' +
        (data.description || "") +
        '"' +
        ' width="40" height="40">';
    }

    html +=
      '<span class="weather-temp">' +
      (data.temp !== null ? data.temp + "\u00B0C" : "\u2014") +
      "</span>";

    html +=
      '<span class="weather-desc">' + (data.description || "") + "</span>";

    html +=
      '<span class="weather-city">' +
      (data.city || "") +
      (data.country ? ", " + data.country : "") +
      "</span>";

    if (stale) {
      html +=
        '<span class="weather-stale"' +
        ' title="Live data is temporarily unavailable; showing cached reading">' +
        "Cached</span>";
    }

    widget.innerHTML = html;
  }

  /**
   * Fetches current weather from the server proxy and updates the widget.
   *
   * @param {HTMLElement} widget
   */
  async function refresh(widget) {
    const city = widget.dataset.city || "";
    const params = city ? "?city=" + encodeURIComponent(city) : "";

    try {
      const res = await fetch("/api/weather" + params);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const result = await res.json();
      render(widget, result);
    } catch (_err) {
      // Network or parse error – leave the server-rendered content intact and
      // mark a real reading as stale so the user knows it might be out of date.
      // There is nothing to mark when the server already showed "unavailable".
      const hasReading = widget.querySelector(".weather-temp");
      const existingStale = widget.querySelector(".weather-stale");
      if (hasReading && !existingStale) {
        const tag = document.createElement("span");
        tag.className = "weather-stale";
        tag.title = "Could not refresh weather data";
        tag.textContent = "Cached";
        widget.appendChild(tag);
      }
    }
  }

  function init() {
    const widget = document.getElementById("weather-widget");
    if (!widget) return;

    // The server normally renders the initial reading. Retry immediately when
    // it could not load one (or only had a stale cached value) instead of
    // leaving the editor pages showing "Weather unavailable" for 15 minutes.
    if (
      !widget.querySelector(".weather-temp") ||
      widget.querySelector(".weather-stale")
    ) {
      refresh(widget);
    }

    setInterval(function () {
      refresh(widget);
    }, REFRESH_INTERVAL_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
