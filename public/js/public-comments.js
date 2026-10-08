// Comments on the article page: add, edit, delete and "Load more" without reloading the page.
// The first page of comments is already in the server-rendered HTML. A new comment is built from the
// record the server returns and added to the top of the list; the list is never fetched again.

const section = document.getElementById("pub-comments");
const form = document.getElementById("pub-comment-form");
const formFields = document.getElementById("pub-comment-fields");
const nameInput = document.getElementById("pub-comment-name");
const bodyInput = document.getElementById("pub-comment-body");
const submitButton = document.getElementById("pub-comment-submit");
const formStatus = document.getElementById("pub-comment-form-status");
const listElement = document.getElementById("pub-comment-list");
const emptyMessage = document.getElementById("pub-comments-empty");
const listStatus = document.getElementById("pub-comments-status");
const moreButton = document.getElementById("pub-comments-more");

const articleId = section.dataset.articleId;
const renderedIds = new Set();
let hasMore = section.dataset.hasMore === "true";
let nextBefore = section.dataset.nextBefore;
let isSubmitting = false;
let isLoadingMore = false;

function createElement(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) {
    element.className = className;
  }
  if (text !== undefined) {
    element.textContent = text;
  }
  return element;
}

function createButton(label, action) {
  const button = createElement("button", "", label);
  button.type = "button";
  button.dataset.action = action;
  return button;
}

// Same format as formatDateTime() in controllers/publicController.js.
function formatDateTime(isoString) {
  return new Date(isoString).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }) + " UTC";
}

// Must produce the same markup as the comment in views/public/article.ejs.
// All API text goes through textContent, never innerHTML.
function createCommentItem(comment) {
  const item = createElement("li", "pub-comment");
  item.dataset.commentId = comment.id;

  const time = createElement("time", "", formatDateTime(comment.createdAt));
  time.dateTime = comment.createdAt;
  const edited = createElement("span", "pub-comment-edited", "(edited)");
  edited.hidden = comment.updatedAt === comment.createdAt;
  const meta = createElement("p", "pub-comment-meta");
  meta.append(createElement("strong", "pub-comment-author", comment.displayName), " ", time, " ", edited);

  item.append(meta, createElement("p", "pub-comment-body", comment.body));

  if (comment.canEdit || comment.canDelete) {
    const actions = createElement("div", "pub-comment-actions");
    if (comment.canEdit) {
      actions.appendChild(createButton("Edit", "edit"));
    }
    if (comment.canDelete) {
      actions.appendChild(createButton("Delete", "delete"));
    }
    item.appendChild(actions);
  }

  const error = createElement("p", "pub-comment-error pub-status-error");
  error.setAttribute("role", "alert");
  error.hidden = true;
  item.appendChild(error);
  return item;
}

// Sends a request and returns the parsed JSON (or null for 204).
// Every failure becomes an Error whose message is safe to show to the user.
async function requestJson(url, options) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    throw new Error("Could not reach the server. Please check your connection and try again.");
  }
  if (response.status === 204) {
    return null;
  }

  let data = null;
  try {
    data = await response.json();
  } catch (error) {
    data = null;
  }
  if (!response.ok) {
    throw new Error(data && typeof data.error === "string" ? data.error : "Something went wrong (status " + response.status + ").");
  }
  if (data === null) {
    throw new Error("The server sent an unexpected answer.");
  }
  return data;
}

function jsonRequest(method, payload) {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) };
}

function setFormStatus(message, isError) {
  formStatus.textContent = message;
  formStatus.classList.toggle("pub-status-error", isError);
}

function showItemError(item, message) {
  const error = item.querySelector(".pub-comment-error");
  error.textContent = message;
  error.hidden = message === "";
}

function updateEmptyMessage() {
  emptyMessage.hidden = listElement.children.length > 0 || hasMore;
}

function appendComments(items) {
  const fragment = document.createDocumentFragment();
  for (const comment of items) {
    // Skip a comment that is already shown.
    if (!renderedIds.has(comment.id)) {
      renderedIds.add(comment.id);
      fragment.appendChild(createCommentItem(comment));
    }
  }
  listElement.appendChild(fragment);
}

form.addEventListener("submit", async function (event) {
  event.preventDefault();
  // A second click while the request is running does nothing.
  if (isSubmitting) {
    return;
  }
  isSubmitting = true;
  submitButton.disabled = true;
  setFormStatus("Posting...", false);

  try {
    const comment = await requestJson(
      "/api/public/articles/" + articleId + "/comments",
      jsonRequest("POST", { displayName: nameInput.value, body: bodyInput.value })
    );
    renderedIds.add(comment.id);
    listElement.prepend(createCommentItem(comment));
    // Only the text of the comment is cleared. The name stays for the next comment.
    bodyInput.value = "";
    updateEmptyMessage();
    setFormStatus("Your comment was posted.", false);
  } catch (error) {
    // The typed text stays in the form so the user can fix it or try again.
    setFormStatus(error.message, true);
  } finally {
    isSubmitting = false;
    submitButton.disabled = false;
  }
});

moreButton.addEventListener("click", async function () {
  if (isLoadingMore || !hasMore) {
    return;
  }
  isLoadingMore = true;
  moreButton.disabled = true;
  listStatus.textContent = "Loading comments...";
  listStatus.classList.remove("pub-status-error");

  try {
    const data = await requestJson("/api/public/articles/" + articleId + "/comments?before=" + encodeURIComponent(nextBefore));
    appendComments(data.items);
    hasMore = data.hasMore;
    if (data.nextBefore) {
      nextBefore = data.nextBefore;
    }
    moreButton.hidden = !hasMore;
    listStatus.textContent = "";
  } catch (error) {
    // The button stays, so pressing it again is the retry.
    listStatus.textContent = error.message;
    listStatus.classList.add("pub-status-error");
  } finally {
    isLoadingMore = false;
    moreButton.disabled = false;
    updateEmptyMessage();
  }
});

function startEdit(item) {
  const bodyElement = item.querySelector(".pub-comment-body");
  const actions = item.querySelector(".pub-comment-actions");

  const textarea = createElement("textarea", "pub-comment-edit-input");
  textarea.rows = 4;
  textarea.maxLength = 1000;
  textarea.value = bodyElement.textContent;
  textarea.setAttribute("aria-label", "Edit your comment");

  const editor = createElement("div", "pub-comment-editor");
  editor.append(textarea, createButton("Save", "save"), createButton("Cancel", "cancel"));

  bodyElement.hidden = true;
  actions.hidden = true;
  bodyElement.after(editor);
  showItemError(item, "");
  textarea.focus();
}

function closeEditor(item) {
  item.querySelector(".pub-comment-editor").remove();
  item.querySelector(".pub-comment-body").hidden = false;
  item.querySelector(".pub-comment-actions").hidden = false;
}

async function saveEdit(item) {
  if (item.dataset.busy === "true") {
    return;
  }
  const textarea = item.querySelector(".pub-comment-edit-input");
  item.dataset.busy = "true";
  setItemButtonsDisabled(item, true);
  showItemError(item, "");

  try {
    const updated = await requestJson("/api/public/comments/" + item.dataset.commentId, jsonRequest("PATCH", { body: textarea.value }));
    item.querySelector(".pub-comment-body").textContent = updated.body;
    item.querySelector(".pub-comment-edited").hidden = updated.updatedAt === updated.createdAt;
    closeEditor(item);
  } catch (error) {
    // The editor stays open with the typed text.
    showItemError(item, error.message);
  } finally {
    item.dataset.busy = "false";
    setItemButtonsDisabled(item, false);
  }
}

async function deleteComment(item) {
  if (item.dataset.busy === "true" || !window.confirm("Delete this comment?")) {
    return;
  }
  item.dataset.busy = "true";
  setItemButtonsDisabled(item, true);
  showItemError(item, "");

  try {
    await requestJson("/api/public/comments/" + item.dataset.commentId, { method: "DELETE" });
    item.remove();
    updateEmptyMessage();
  } catch (error) {
    showItemError(item, error.message);
    item.dataset.busy = "false";
    setItemButtonsDisabled(item, false);
  }
}

function setItemButtonsDisabled(item, disabled) {
  for (const button of item.querySelectorAll("button")) {
    button.disabled = disabled;
  }
}

// One listener for all comments, including the ones added later.
listElement.addEventListener("click", function (event) {
  const button = event.target.closest("button[data-action]");
  const item = button && button.closest(".pub-comment");
  if (!item) {
    return;
  }
  const action = button.dataset.action;
  if (action === "edit") {
    startEdit(item);
  } else if (action === "cancel") {
    closeEditor(item);
  } else if (action === "save") {
    saveEdit(item);
  } else if (action === "delete") {
    deleteComment(item);
  }
});

for (const item of listElement.querySelectorAll("[data-comment-id]")) {
  renderedIds.add(item.dataset.commentId);
}

// The fieldset is disabled in the HTML. Enable it only now that the submit handler exists, so the
// form can never be sent as a plain GET (which would put the comment text in the URL).
formFields.disabled = false;
