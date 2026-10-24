(() => {
  const form = document.getElementById("impact-controls");
  const select = document.getElementById("impact-article");
  const status = document.getElementById("impact-status");
  const result = document.getElementById("impact-result");
  const warning = document.getElementById("impact-warning");
  const from = document.getElementById("impact-from"),
    to = document.getElementById("impact-to");
  const resolution = document.getElementById("impact-resolution");
  const deleteButton = document.getElementById("impact-delete");
  let deleting = false;
  let chartData;
  let version = 0;
  let searchVersion = 0;
  const now = new Date();
  to.value = new Date(now.getTime() + 60000).toISOString().slice(0, 16);
  from.value = new Date(now.getTime() - 30 * 86400000)
    .toISOString()
    .slice(0, 16);
  const initialId = new URLSearchParams(window.location.search).get("article");
  const utcText = (iso) => iso.replace("T", " ").replace(/\.\d{3}Z$/, " UTC");

  async function json(url) {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(
        body.error || "Could not load analytics. Please try again.",
      );
    }
    return response.json();
  }
  function fillTable(data) {
    const table = document.getElementById("impact-table");
    table.replaceChildren();
    for (const point of data.points) {
      const row = document.createElement("tr");
      for (const value of [utcText(point.at), point.views]) {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.appendChild(cell);
      }
      table.appendChild(row);
    }
    const events = document.getElementById("impact-events");
    events.replaceChildren();
    for (const marker of data.markers) {
      const item = document.createElement("li");
      item.textContent = `${utcText(marker.at)} — ${marker.first ? "First publication" : `Approved update ${marker.version - 1}`} (version ${marker.version})`;
      events.appendChild(item);
    }
    document.getElementById("impact-no-markers").hidden =
      data.markers.length > 0;
  }
  async function loadImpact() {
    if (deleting || !form.reportValidity()) return false;
    deleteButton.disabled = true;
    const current = ++version;
    // Never leave a chart for the previous article under a newly selected article name.
    result.hidden = true;
    warning.hidden = true;
    status.textContent = "Loading analytics…";
    try {
      const query = new URLSearchParams({
        from: from.value + ":00.000Z",
        to: to.value + ":00.000Z",
        resolution: resolution.value,
      });
      const data = await json(
        `/api/editor/articles/${encodeURIComponent(select.value)}/impact?${query}`,
      );
      if (current !== version) return;
      chartData = data;
      document.getElementById("impact-title").textContent = data.article.title;
      document.getElementById("impact-total").textContent =
        `Total recorded views: ${data.article.totalViews.toLocaleString()}`;
      document.getElementById("impact-range-total").textContent =
        `Views in displayed intervals: ${data.rangeViews.toLocaleString()}`;
      if (data.dailyOnlyViews) {
        warning.textContent = `The selected dates include ${data.dailyOnlyViews.toLocaleString()} historical views stored as whole-day totals only. They cannot be placed in specific hours or minutes and are excluded here. Select Day to include them.`;
        warning.hidden = false;
      }
      fillTable(data);
      result.hidden = false;
      window.drawImpactChart(document.getElementById("impact-chart"), data);
      status.textContent = data.rangeViews
        ? "Graph updated."
        : "No recorded views at this resolution in the selected range.";
      const url = new URL(window.location.href);
      url.searchParams.set("article", select.value);
      window.history.replaceState(null, "", url);
      updateDeleteButton();
      return true;
    } catch (error) {
      if (current === version) status.textContent = error.message;
      return false;
    }
  }
  async function searchArticles(first = false) {
    if (deleting) return;
    ++version;
    result.hidden = true;
    warning.hidden = true;
    deleteButton.disabled = true;
    const current = ++searchVersion;
    status.textContent = "Loading articles…";
    try {
      const query = new URLSearchParams({
        q: document.getElementById("impact-search").value,
        page: "1",
      });
      const data = await json(`/api/editor/articles?${query}`);
      if (current !== searchVersion) return;
      const previous = first ? initialId : select.value;
      select.replaceChildren(new Option("Choose an article", ""));
      for (const article of data.items)
        select.add(new Option(article.title, article.id));
      if (previous && data.items.some((article) => article.id === previous))
        select.value = previous;
      else if (first && initialId && /^[0-9a-f]{24}$/i.test(initialId)) {
        const article = await json(`/api/articles/${initialId}`);
        if (current !== searchVersion) return;
        select.add(new Option(article.draft.title || "Untitled", article.id));
        select.value = article.id;
      }
      ++version;
      result.hidden = true;
      warning.hidden = true;
      status.textContent = data.items.length
        ? `Showing ${data.items.length} of ${data.total} articles. Search by title to narrow the list.`
        : "No articles found.";
      if (select.value) await loadImpact();
    } catch (error) {
      if (current === searchVersion) status.textContent = error.message;
    }
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    loadImpact();
  });
  select.addEventListener("change", () => {
    ++version;
    result.hidden = true;
    warning.hidden = true;
    if (select.value) loadImpact();
  });
  document
    .getElementById("article-search")
    .addEventListener("submit", (event) => {
      event.preventDefault();
      searchArticles();
    });
  resolution.addEventListener("change", () => {
    const end = new Date(to.value + ":00Z");
    const duration =
      resolution.value === "minute"
        ? 24 * 3600000
        : resolution.value === "hour"
          ? 7 * 86400000
          : 30 * 86400000;
    from.value = new Date(end.getTime() - duration).toISOString().slice(0, 16);
  });
  new ResizeObserver(() => {
    if (chartData && !result.hidden)
      window.drawImpactChart(
        document.getElementById("impact-chart"),
        chartData,
      );
  }).observe(document.getElementById("impact-chart").parentElement);
  function updateDeleteButton() {
    deleteButton.disabled =
      deleting ||
      result.hidden ||
      !chartData ||
      chartData.resolution !== "day" ||
      chartData.rangeViews === 0;
  }

  deleteButton.addEventListener("click", async () => {
    if (
      deleteButton.disabled ||
      deleting ||
      result.hidden ||
      !chartData ||
      chartData.resolution !== "day"
    )
      return;
    // Use the range/article of the displayed graph, never unsubmitted input fields.
    const displayed = chartData;
    const question = `Permanently delete view statistics for "${displayed.article.title}"?\n\nUTC range: ${utcText(displayed.from)} up to ${utcText(displayed.to)} (end excluded).\n\nAll recorded views in these days will be removed and the article's total will decrease. This cannot be undone. The article and publication timeline will remain.`;
    if (!window.confirm(question)) return;
    deleting = true;
    ++version;
    const controls = [...document.querySelectorAll("input, select, button")];
    controls.forEach((control) => {
      control.disabled = true;
    });
    status.textContent = "Deleting view statistics…";
    try {
      const response = await fetch(
        `/api/editor/articles/${encodeURIComponent(displayed.article.id)}/views`,
        {
          method: "DELETE",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            from: displayed.from,
            to: displayed.to,
            confirm: true,
          }),
        },
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(
          body.error ||
            "Deletion failed. Reload the graph before trying again.",
        );
      chartData = null;
      result.hidden = true;
      deleting = false;
      const refreshed = await loadImpact();
      status.textContent = `Deleted ${body.deletedViews.toLocaleString()} views from ${body.deletedBuckets} daily records. ${refreshed ? "Graph updated." : "Select Show graph to reload the latest data."}`;
    } catch (error) {
      // A lost response does not prove the transaction failed; prevent blind repeat clicks.
      chartData = null;
      result.hidden = true;
      warning.hidden = true;
      status.textContent = `${error.message || "Could not reach the server."} Reload the graph to verify the result.`;
    } finally {
      deleting = false;
      controls.forEach((control) => {
        control.disabled = false;
      });
      updateDeleteButton();
    }
  });
  // Changing a selection requires displaying its graph again before deletion is available.
  form.addEventListener("input", () => {
    deleteButton.disabled = true;
  });

  searchArticles(true);
})();
