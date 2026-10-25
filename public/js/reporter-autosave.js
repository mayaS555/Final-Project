// Autosave for the article edit page (owned by B). Used by views/reporter/edit.ejs when the article can be edited,
// and by public/js/reporter-edit.js (saveAllNow before submitting). Changes go to PATCH /api/articles/:id 1.5 s
// after the last keystroke, one save at a time; the server is the only copy (no localStorage). When the page is
// hidden or closed, pending changes are sent at once.

const form = document.getElementById("rep-edit-form");
const fieldset = form.querySelector(".rep-fields");
const statusElement = document.getElementById("rep-save-status");

const ARTICLE_URL = `/api/articles/${form.dataset.articleId}`;
const FIELD_NAMES = ["title", "summary", "content", "imageUrl", "category"];
const SAVE_DELAY_MS = 1500;
// Waits between attempts after a failed save; the last one repeats until a save works.
const RETRY_DELAYS_MS = [2000, 4000, 8000, 15000];
// Browsers refuse keepalive requests with a body over 64 KB.
const MAX_KEEPALIVE_BYTES = 60000;

// Fields changed since they were last sent. Not empty means there are unsaved changes.
const changedFields = new Set();
let saveTimer = null;
let savesInFlight = 0;
// Resolves when the running save (not a keepalive one) has finished; null when none is running.
let currentSave = null;
let failedAttempts = 0;
// true when the last save did not reach the server (offline, error or stopped).
let lastSaveFailed = false;
// Set after a 401, 403 or 409: saving more would not work, so autosave stops until the page is reloaded.
let isStopped = false;

/**
 * Shows the save state next to the title.
 * @param {string} state "saving", "saved", "offline", "error" or "stopped".
 * @param {string} [detail] For "saved": the server's savedAt (ISO). For "error" and "stopped": the message.
 * @returns {void}
 * @example setStatus("saved", "2026-10-18T09:30:00.000Z"); // "Saved at 12:30" (local time)
 */
function setStatus(state, detail) {
  const texts = {
    saving: "Saving…",
    saved: `Saved at ${new Date(detail).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
    offline: "Offline – will retry",
  };
  statusElement.textContent = texts[state] || detail;
  statusElement.dataset.state = state;
  statusElement.classList.toggle(
    "pub-status-error",
    state === "error" || state === "stopped",
  );
}

/**
 * Waits a moment, then saves. A new call restarts the wait, so typing sends one save after the last keystroke.
 * @param {number} [delayMs] How long to wait; the normal typing delay by default.
 * @returns {void}
 * @example form.addEventListener("input", () => scheduleSave());
 */
function scheduleSave(delayMs = SAVE_DELAY_MS) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, delayMs);
}

/**
 * Reads the current value of some fields.
 * @param {string[]} names Field names from FIELD_NAMES.
 * @returns {Object} For example { title: "Storm" }.
 * @example readFields(["title"])
 */
function readFields(names) {
  const fields = {};
  for (const name of names) {
    fields[name] = form.elements[name].value;
  }
  return fields;
}

/**
 * Stops autosave for good on this page view and tells the user to reload.
 * @param {string} message What happened and what to do.
 * @returns {void}
 * @example stopAutosave("Reload the page.");
 */
function stopAutosave(message) {
  isStopped = true;
  clearTimeout(saveTimer);
  fieldset.disabled = true;
  setStatus("stopped", message);
}

/**
 * Handles a failed save: puts the fields back as unsaved, then retries later or stops, depending on the answer.
 * @param {string[]} names The fields that were sent.
 * @param {Response|null} response The server's answer, or null when the network failed.
 * @returns {Promise<void>}
 * @example await handleFailedSave(names, response);
 */
async function handleFailedSave(names, response) {
  lastSaveFailed = true;
  names.forEach((name) => changedFields.add(name));
  const status = response ? response.status : 0;
  const body = response ? await response.json().catch(() => ({})) : {};

  if (status === 401) {
    stopAutosave(
      "You are no longer logged in. Copy your latest changes, log in again, then reload this page.",
    );
  } else if (status === 403 || status === 409) {
    stopAutosave(
      "This article was changed elsewhere (for example, it was submitted or an editor opened it). Your latest changes were not saved. Reload the page.",
    );
  } else if (status === 400) {
    // Bad input does not get better by retrying; the next change tries again.
    setStatus(
      "error",
      `Not saved: ${body.error || "please check the fields."}`,
    );
  } else {
    // Network failure or a server error: keep the data and try again later.
    setStatus("offline");
    scheduleSave(
      RETRY_DELAYS_MS[Math.min(failedAttempts, RETRY_DELAYS_MS.length - 1)],
    );
    failedAttempts += 1;
  }
}

/**
 * Sends the changed fields to the server now (and cancels a waiting save).
 * Only one save runs at a time: if one is in flight, this does nothing and the changes are sent when it ends.
 * When the page is being hidden or closed (keepalive), it sends anyway, because there is no "later".
 * @param {{ keepalive?: boolean }} [options] keepalive: true lets the request finish after the page is gone.
 * @returns {Promise<void>} Resolves when the save is done. Never rejects; failures are shown with setStatus.
 * @example await saveNow();
 */
async function saveNow({ keepalive = false } = {}) {
  clearTimeout(saveTimer);
  if (
    isStopped ||
    changedFields.size === 0 ||
    (savesInFlight > 0 && !keepalive)
  ) {
    return;
  }
  const names = [...changedFields];
  changedFields.clear();
  const body = JSON.stringify(readFields(names));

  savesInFlight += 1;
  let markSaveDone;
  const thisSave = new Promise((resolve) => (markSaveDone = resolve));
  if (!keepalive) {
    currentSave = thisSave;
  }
  setStatus("saving");
  let response = null;
  try {
    response = await fetch(ARTICLE_URL, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body,
      // ponytail: a very long text over the keepalive limit is sent normally and may be cut off on close;
      // beforeunload still warns in that case.
      keepalive: keepalive && new Blob([body]).size <= MAX_KEEPALIVE_BYTES,
    });
  } catch (error) {
    response = null;
  }
  savesInFlight -= 1;

  if (response && response.ok) {
    failedAttempts = 0;
    lastSaveFailed = false;
    const result = await response.json().catch(() => ({}));
    setStatus("saved", result.savedAt || new Date().toISOString());
  } else {
    await handleFailedSave(names, response);
  }

  if (currentSave === thisSave) {
    currentSave = null;
  }
  // Changes made while this save was running are sent right after it. After a failure the retry timer does it.
  // This runs before anyone waiting on thisSave continues, so saveAllNow sees the follow-up save.
  if (
    !isStopped &&
    !lastSaveFailed &&
    changedFields.size > 0 &&
    savesInFlight === 0
  ) {
    saveNow();
  }
  markSaveDone();
}

/**
 * Saves every pending change and waits until nothing is left to save, including a save already running.
 * Used before submitting, so the editor gets exactly what is on the screen.
 * @returns {Promise<boolean>} true when everything is saved; false when a save failed or autosave stopped
 *   (the status line then says why).
 * @example if (await saveAllNow()) { submit(); }
 */
async function saveAllNow() {
  clearTimeout(saveTimer);
  for (;;) {
    if (isStopped) {
      return false;
    }
    if (currentSave) {
      await currentSave;
    } else if (savesInFlight > 0) {
      // Only a keepalive save (page was hidden) is running; give it a moment.
      await new Promise((resolve) => setTimeout(resolve, 200));
    } else if (changedFields.size === 0) {
      return !lastSaveFailed;
    } else {
      await saveNow();
      if (lastSaveFailed) {
        return false;
      }
    }
  }
}

/**
 * Sends pending changes immediately when the page is hidden or closed.
 * @returns {void}
 * @example document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushOnExit(); });
 */
function flushOnExit() {
  if (changedFields.size > 0) {
    saveNow({ keepalive: true });
  }
}

/**
 * Tells whether leaving now could lose changes: they could not be sent, or the last attempt failed.
 * @returns {boolean} true when the browser should ask before leaving.
 * @example if (hasUnsavedChanges()) event.preventDefault();
 */
function hasUnsavedChanges() {
  // A save still in flight after a failure (for example, sent while offline) will probably fail too.
  return changedFields.size > 0 || (savesInFlight > 0 && lastSaveFailed);
}

form.addEventListener("input", (event) => {
  if (isStopped || !FIELD_NAMES.includes(event.target.name)) {
    return;
  }
  changedFields.add(event.target.name);
  scheduleSave();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    flushOnExit();
  }
});

window.addEventListener("pagehide", flushOnExit);

// The pending changes are sent first; the browser asks "Leave site?" only if they could not be sent.
window.addEventListener("beforeunload", (event) => {
  flushOnExit();
  if (hasUnsavedChanges()) {
    event.preventDefault();
    event.returnValue = "";
  }
});

// Back online: retry at once instead of waiting for the next retry.
window.addEventListener("online", () => saveNow());
