// Light/dark theme toggle. Loaded in <head> without defer so the theme is set before the page paints.
(function () {
    const root = document.documentElement;
    let saved = null;
    try {
        saved = localStorage.getItem("theme");
    } catch (error) {
        // Storage can be blocked (private mode); fall back to the system setting.
    }
    const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = saved || (systemDark ? "dark" : "light");

    document.addEventListener("DOMContentLoaded", function () {
        const button = document.getElementById("theme-toggle");
        if (!button) return;

        function render() {
            const dark = root.dataset.theme === "dark";
            button.textContent = dark ? "☀️ Light" : "🌙 Dark";
            button.setAttribute("aria-pressed", String(dark));
        }

        button.addEventListener("click", function () {
            root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
            try {
                localStorage.setItem("theme", root.dataset.theme);
            } catch (error) {
                // Not saved; the choice still applies until the page reloads.
            }
            render();
        });

        render();
        button.hidden = false;
    });
})();
