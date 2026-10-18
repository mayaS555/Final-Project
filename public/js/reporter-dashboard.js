// Reporter dashboard actions (owned by B): "New article", "Edit published article" and "Delete".
// Each one calls the Article API with fetch; the server checks every permission again.
// Used by views/reporter/dashboard.ejs. The buttons stay disabled until this script has attached its handlers.

const newArticleButton = document.getElementById("rep-new-article");
const listElement = document.getElementById("rep-list");
const emptyMessage = document.getElementById("rep-empty");
const statusLine = document.getElementById("rep-status");

/**
 * Shows a message above the list.
 * @param {string} text The message ("" clears it).
 * @param {boolean} isError true shows it as an error.
 * @returns {void}
 * @example showStatus("Article deleted.", false);
 */
function showStatus(text, isError) {
  statusLine.textContent = text;
  statusLine.classList.toggle("pub-status-error", isError);
}

/**
 * Sends a request to the Article API and returns the parsed answer.
 * @param {string} method "POST" or "DELETE".
 * @param {string} url The API path.
 * @returns {Promise<Object|null>} The JSON body, or null for 204.
 * @throws {Error} With the server's error message when the answer is not 2xx.
 * @example const article = await callApi("POST", "/api/articles");
 */
async function callApi(method, url) {
  // The API accepts writes only as application/json (a cross-site form cannot send that).
  const response = await fetch(url, { method, headers: { "Content-Type": "application/json" } });
  if (response.status === 204) {
    return null;
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || "Something went wrong. Please try again.");
  }
  return body;
}

/**
 * Runs an action with its button disabled, and shows the error if it fails.
 * @param {HTMLButtonElement} button The button that started the action.
 * @param {Function} action An async function.
 * @returns {Promise<void>}
 * @example runAction(button, () => deleteArticle(row));
 */
async function runAction(button, action) {
  button.disabled = true;
  showStatus("", false);
  try {
    await action();
  } catch (error) {
    showStatus(error.message, true);
    button.disabled = false;
  }
}

/**
 * Creates an empty draft and opens its edit page.
 * @returns {Promise<void>}
 * @example newArticleButton.addEventListener("click", ...)
 */
async function createArticle() {
  const article = await callApi("POST", "/api/articles");
  window.location.href = `/reporter/articles/${article.id}/edit`;
}

/**
 * Reopens a published article as a draft and opens its edit page.
 * @param {HTMLElement} row The article's list item.
 * @returns {Promise<void>}
 * @example await reviseArticle(row);
 */
async function reviseArticle(row) {
  await callApi("POST", `/api/articles/${row.dataset.articleId}/revise`);
  window.location.href = row.dataset.editUrl;
}

/**
 * Deletes an article after the reporter confirms, and removes its row.
 * @param {HTMLElement} row The article's list item.
 * @returns {Promise<void>}
 * @example await deleteArticle(row);
 */
async function deleteArticle(row) {
  const title = row.querySelector(".rep-row-title").textContent;
  if (!window.confirm(`Delete "${title}"? This cannot be undone.`)) {
    row.querySelector('[data-action="delete"]').disabled = false;
    return;
  }
  await callApi("DELETE", `/api/articles/${row.dataset.articleId}`);
  row.remove();
  emptyMessage.hidden = listElement.children.length > 0;
  showStatus("Article deleted.", false);
}

newArticleButton.addEventListener("click", () => runAction(newArticleButton, createArticle));

listElement.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) {
    return;
  }
  const row = button.closest(".rep-row");
  if (button.dataset.action === "revise") {
    runAction(button, () => reviseArticle(row));
  } else if (button.dataset.action === "delete") {
    runAction(button, () => deleteArticle(row));
  }
});

// Handlers are attached: the buttons can be used now.
newArticleButton.disabled = false;
for (const button of listElement.querySelectorAll("button[data-action]")) {
  button.disabled = false;
}
