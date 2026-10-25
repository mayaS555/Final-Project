(() => {
  const page = document.getElementById("editor-page");
  if (!page) return;
  const id = page.dataset.articleId;
  const message = document.getElementById("editor-message");
  const form = document.getElementById("editor-edit-form");
  const preview = document.getElementById("article-preview");
  const actions = document.getElementById("action-buttons");
  const returnSection = document.getElementById("return-section");
  const returnForm = document.getElementById("editor-return-form");
  const buttons = [...page.querySelectorAll("button")];
  let busy = false;
  let locked = false;
  let dirty = false;
  let noteDirty = false;

  function finishAction(destination) {
    dirty = false;
    noteDirty = false;
    setBusy(false);
    if (destination) window.location.href = destination;
    else window.location.reload();
  }

  function showMessage(text, error = false) {
    message.textContent = text;
    message.classList.toggle("error", error);
  }

  function setBusy(value) {
    busy = value;
    buttons.forEach((button) => {
      button.disabled = value || locked;
    });
    document.getElementById("editor-fields").disabled = value || locked;
    if (returnForm) returnForm.elements.note.disabled = value || locked;
  }

  async function request(method, suffix = "", body) {
    const response = await fetch(
      `/api/articles/${encodeURIComponent(id)}${suffix}`,
      {
        method,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
    if (!response.ok) {
      let text = "The request failed. Please try again.";
      try {
        text = (await response.json()).error || text;
      } catch {
        // Use the fallback for non-JSON responses.
      }
      if ([401, 403, 409].includes(response.status)) {
        locked = true;
        text +=
          " Reload the page before trying again. Copy any unsaved text first.";
      }
      throw new Error(text);
    }
  }

  async function runAction(task) {
    if (busy || locked) return;
    setBusy(true);
    showMessage("Working…");
    try {
      await task();
    } catch (error) {
      showMessage(
        error.name === "TypeError"
          ? "Could not reach the server. Your input is still here; please try again."
          : error.message,
        true,
      );
    } finally {
      setBusy(false);
    }
  }

  document.getElementById("start-edit")?.addEventListener("click", () => {
    if (busy || locked) return;
    form.hidden = false;
    preview.hidden = true;
    actions.hidden = true;
    if (returnSection) returnSection.hidden = true;
    form.elements.title.focus();
    showMessage("Changes are saved only when you select Save Changes.");
  });

  form.addEventListener("input", () => {
    dirty = true;
  });
  document.getElementById("cancel-edit").addEventListener("click", () => {
    if (busy || locked) return;
    form.reset();
    dirty = false;
    form.hidden = true;
    preview.hidden = false;
    actions.hidden = false;
    showMessage("");
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const fields = {};
    for (const name of ["title", "summary", "content", "imageUrl", "category"])
      fields[name] = form.elements[name].value;
    runAction(async () => {
      await request("PATCH", "", fields);
      finishAction();
    });
  });

  document.getElementById("approve-article")?.addEventListener("click", () => {
    if (
      busy ||
      locked ||
      !window.confirm("Approve and publish this version of the article?")
    )
      return;
    runAction(async () => {
      await request("POST", "/approve", {});
      finishAction();
    });
  });

  document.getElementById("show-return")?.addEventListener("click", () => {
    if (busy || locked) return;
    returnSection.hidden = !returnSection.hidden;
    if (!returnSection.hidden) returnForm.elements.note.focus();
  });
  returnForm?.addEventListener("input", () => {
    noteDirty = true;
  });
  returnForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!returnForm.reportValidity()) return;
    runAction(async () => {
      await request("POST", "/return", {
        note: returnForm.elements.note.value,
      });
      finishAction();
    });
  });
  document.getElementById("delete-article")?.addEventListener("click", () => {
    if (
      busy ||
      locked ||
      !window.confirm(
        "Delete this article? It will also be removed from the public site if it is published.",
      )
    )
      return;
    runAction(async () => {
      await request("DELETE");
      finishAction("/editor");
    });
  });

  window.addEventListener("beforeunload", (event) => {
    if (dirty || noteDirty || busy) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  setBusy(false);
})();
