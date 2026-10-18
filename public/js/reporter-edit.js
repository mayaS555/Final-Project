// "Submit for approval" / "Resubmit" on the edit page (owned by B). Used by views/reporter/edit.ejs, only for the
// article's author in draft or returned. Loaded after reporter-autosave.js and uses its form, fieldset, isStopped
// and saveAllNow(): both are classic scripts, so their top-level names are shared (do not declare them again).
// The server checks everything again; this only saves first, sends the request and shows the answer.

const submitButton = document.getElementById("rep-submit");
const formMessage = document.getElementById("rep-edit-status");
const REQUIRED_FIELDS = form.dataset.requiredFields.split(",");

/**
 * Shows a message under the form.
 * @param {string} text The message.
 * @param {boolean} isError true shows it as an error.
 * @returns {void}
 * @example showFormMessage("Sending to the editors…", false);
 */
function showFormMessage(text, isError) {
  formMessage.textContent = text;
  formMessage.classList.toggle("pub-status-error", isError);
}

/**
 * Marks the required fields that are empty, and unmarks the others.
 * @returns {string[]} The names of the empty required fields, in form order.
 * @example const missing = markMissingFields(); // ["title", "category"]
 */
function markMissingFields() {
  const missing = [];
  for (const name of REQUIRED_FIELDS) {
    const field = form.elements[name];
    const isEmpty = field.value.trim() === "";
    if (isEmpty) {
      field.setAttribute("aria-invalid", "true");
      missing.push(name);
    } else {
      field.removeAttribute("aria-invalid");
    }
  }
  return missing;
}

/**
 * The visible label of a field, for messages.
 * @param {string} name The field name.
 * @returns {string} For example "Article text" for "content".
 * @example fieldLabel("content")
 */
function fieldLabel(name) {
  return form.querySelector(`label[for="${form.elements[name].id}"]`).textContent;
}

/**
 * Makes the form usable again after a failed submit (unless autosave stopped, which keeps it locked).
 * @returns {void}
 * @example unlockForm();
 */
function unlockForm() {
  if (!isStopped) {
    fieldset.disabled = false;
    submitButton.disabled = false;
  }
}

/**
 * Saves the latest changes, then sends the article to the editors and opens the dashboard with a message.
 * The button and the fields stay disabled while it runs, so it cannot be sent twice.
 * @returns {Promise<void>} Never rejects; problems are shown with showFormMessage.
 * @example submitButton.addEventListener("click", submitArticle);
 */
async function submitArticle() {
  submitButton.disabled = true;
  fieldset.disabled = true;
  showFormMessage("Saving your latest changes…", false);

  // The editor must get exactly what is on the screen.
  if (!(await saveAllNow())) {
    showFormMessage("Your latest changes are not saved, so the article was not sent. See the message next to the title.", true);
    unlockForm();
    return;
  }

  showFormMessage("Sending to the editors…", false);
  let response;
  try {
    // The API accepts writes only as application/json (a cross-site form cannot send that).
    response = await fetch(`/api/articles/${form.dataset.articleId}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    showFormMessage("Could not reach the server. Check your connection and try again.", true);
    unlockForm();
    return;
  }

  if (response.ok) {
    window.location.href = `/reporter?msg=${form.dataset.status === "returned" ? "resubmitted" : "submitted"}`;
    return;
  }

  const body = await response.json().catch(() => ({}));
  if (response.status === 400) {
    unlockForm();
    const missing = markMissingFields();
    if (missing.length > 0) {
      showFormMessage(`Please fill in: ${missing.map(fieldLabel).join(", ")}.`, true);
      form.elements[missing[0]].focus();
    } else {
      showFormMessage(body.error || "The article could not be sent.", true);
    }
    return;
  }
  // 403 / 409: the article changed on the server (for example, it was already submitted). Sending again would
  // not help, so the form stays locked.
  showFormMessage(`${body.error || "The article could not be sent."} Reload the page to see its current state.`, true);
}

// A field marked as missing is unmarked as soon as the reporter types in it.
form.addEventListener("input", (event) => {
  if (event.target.removeAttribute) {
    event.target.removeAttribute("aria-invalid");
  }
});

submitButton.addEventListener("click", submitArticle);
// The handler is attached: the button can be used now.
submitButton.disabled = false;
