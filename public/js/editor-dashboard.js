(() => {
  const root = document.getElementById("editor-dashboard"),
    list = document.getElementById("articles-list");
  const status = document.getElementById("editor-list-status"),
    search = document.getElementById("editor-search"),
    statusInput = document.getElementById("editor-search-status");
  let version = 0;
  async function load(url, push = true) {
    const current = ++version;
    status.textContent = "Loading articles…";
    list.setAttribute("aria-busy", "true");
    try {
      const response = await fetch(`/api/editor/articles${url.search}`, {
        headers: { Accept: "application/json" },
      });
      const data = await response.json();
      if (current !== version) return;
      if (!response.ok)
        throw new Error(data.error || "Could not load articles.");
      list.innerHTML = data.html;
      const active = url.searchParams.get("status") || "";
      for (const link of root.querySelectorAll(".filter-link")) {
        const selected =
          (new URL(link.href).searchParams.get("status") || "") === active;
        link.classList.toggle("active", selected);
        if (selected) link.setAttribute("aria-current", "page");
        else link.removeAttribute("aria-current");
      }
      search.value = url.searchParams.get("q") || "";
      statusInput.value = active;
      if (push) window.history.pushState(null, "", url);
      status.textContent = `${data.total} articles found.`;
    } catch (error) {
      if (current === version)
        status.textContent =
          error.message || "Could not reach the server. Please try again.";
    } finally {
      if (current === version) list.removeAttribute("aria-busy");
    }
  }
  root.addEventListener("click", (event) => {
    const link = event.target.closest("a");
    if (
      !link ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey ||
      event.button
    )
      return;
    const url = new URL(link.href);
    if (url.origin !== window.location.origin || url.pathname !== "/editor")
      return;
    event.preventDefault();
    if (link.classList.contains("filter-link") && search.value)
      url.searchParams.set("q", search.value);
    load(url);
  });
  document
    .getElementById("editor-search-form")
    .addEventListener("submit", (event) => {
      event.preventDefault();
      const url = new URL("/editor", window.location.origin);
      if (statusInput.value) url.searchParams.set("status", statusInput.value);
      if (search.value.trim()) url.searchParams.set("q", search.value.trim());
      load(url);
    });
  window.addEventListener("popstate", () =>
    load(new URL(window.location.href), false),
  );
})();
