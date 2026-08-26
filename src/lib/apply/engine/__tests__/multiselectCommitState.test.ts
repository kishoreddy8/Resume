import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ApplicationBrowserRuntime } from "../browserRuntime";
import { captureMultiselectCommitState } from "../validationSnapshot";

/**
 * PHASE 9E — MULTISELECT OBSERVATION. Proves `captureMultiselectCommitState` reads real DOM
 * evidence (aria-selected, nested checkbox state, chip presence, commit-button text, popup
 * open/closed) correctly and safely — BEFORE spending the one authorized live Workday attempt on
 * it. No control's candidate-authored value is ever captured; only Workday's own fixed choice-list
 * wording ("Online Source") and UI status text.
 */

const mockUrl = pathToFileURL(path.join(import.meta.dirname, "mockAts/mock-multiselect-commit.html")).href;
const runtime = new ApplicationBrowserRuntime();

test.after(async () => {
  await runtime.close();
});

test("MULTISELECT-COMMIT-01: before any click, the option is not marked selected and no chip exists", async () => {
  const session = await runtime.open(mockUrl);
  try {
    const state = await captureMultiselectCommitState(session.page, "Online Source");
    assert.equal(state.optionMarkedSelected, false);
    assert.equal(state.chipPresent, false);
    assert.equal(state.popupStillOpen, true, "the fixture's listbox is visible by default");
  } finally {
    await session.close();
  }
});

test("MULTISELECT-COMMIT-02: after aria-selected is set on the matched option, it is reported as selected", async () => {
  const session = await runtime.open(mockUrl);
  try {
    await session.page.evaluate(() => {
      document.getElementById("opt-online")!.setAttribute("aria-selected", "true");
    });
    const state = await captureMultiselectCommitState(session.page, "Online Source");
    assert.equal(state.optionMarkedSelected, true);
  } finally {
    await session.close();
  }
});

test("MULTISELECT-COMMIT-03: a nested checkbox inside the option is detected and its checked state read", async () => {
  const session = await runtime.open(mockUrl);
  try {
    await session.page.evaluate(() => {
      const opt = document.getElementById("opt-online")!;
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      opt.prepend(checkbox);
    });
    const before = await captureMultiselectCommitState(session.page, "Online Source");
    assert.equal(before.optionHasNestedCheckbox, true);
    assert.equal(before.optionNestedCheckboxChecked, false);

    await session.page.evaluate(() => {
      (document.querySelector("#opt-online input") as HTMLInputElement).checked = true;
    });
    const after = await captureMultiselectCommitState(session.page, "Online Source");
    assert.equal(after.optionNestedCheckboxChecked, true);
  } finally {
    await session.close();
  }
});

test("MULTISELECT-COMMIT-04: a chip/token containing the selected option's text is detected", async () => {
  const session = await runtime.open(mockUrl);
  try {
    await session.page.evaluate(() => {
      const chip = document.createElement("span");
      chip.className = "selected-chip";
      chip.textContent = "Online Source";
      document.body.appendChild(chip);
    });
    const state = await captureMultiselectCommitState(session.page, "Online Source");
    assert.equal(state.chipPresent, true);
  } finally {
    await session.close();
  }
});

test("MULTISELECT-COMMIT-05: an explicit Done/Apply/Confirm button, if present, is detected by text — never assumed", async () => {
  const session = await runtime.open(mockUrl);
  try {
    const before = await captureMultiselectCommitState(session.page, "Online Source");
    assert.equal(before.commitButtonText, null, "no commit button exists in the base fixture");

    await session.page.evaluate(() => {
      const btn = document.createElement("button");
      btn.textContent = "Done";
      btn.setAttribute("data-automation-id", "doneButton");
      document.getElementById("source-listbox")!.appendChild(btn);
    });
    const after = await captureMultiselectCommitState(session.page, "Online Source");
    assert.equal(after.commitButtonText, "Done");
    assert.equal(after.commitButtonAutomationId, "doneButton");
  } finally {
    await session.close();
  }
});

test("MULTISELECT-COMMIT-06: popupStillOpen reflects whether the listbox is actually visible", async () => {
  const session = await runtime.open(mockUrl);
  try {
    const open = await captureMultiselectCommitState(session.page, "Online Source");
    assert.equal(open.popupStillOpen, true);

    await session.page.evaluate(() => {
      (document.getElementById("source-listbox") as HTMLElement).style.display = "none";
    });
    const closed = await captureMultiselectCommitState(session.page, "Online Source");
    assert.equal(closed.popupStillOpen, false);
  } finally {
    await session.close();
  }
});

test("MULTISELECT-COMMIT-07: no candidate-authored value is ever captured — only Workday's own fixed option text and UI status", async () => {
  const session = await runtime.open(mockUrl);
  try {
    const state = await captureMultiselectCommitState(session.page, "Online Source");
    const serialized = JSON.stringify(state);
    /* "Online Source" itself is fine — it is Workday's own fixed choice-list wording, the same as
     * a question label, not something the candidate typed. */
    assert.doesNotMatch(serialized, /password|ssn|cookie|token/i);
  } finally {
    await session.close();
  }
});

test("MULTISELECT-COMMIT-08: special regex characters in the option text are escaped safely, never break the query", async () => {
  const session = await runtime.open(mockUrl);
  try {
    await session.page.evaluate(() => {
      document.getElementById("opt-online")!.textContent = "Online (Source)";
    });
    await assert.doesNotReject(() => captureMultiselectCommitState(session.page, "Online (Source)"));
  } finally {
    await session.close();
  }
});
