import type { Page } from "playwright";

/**
 * PHASE 9E — a read-only, sanitized snapshot of a page's own validation state.
 *
 * WHY THIS EXISTS. Run 21 filled all 12 fields the engine could see on State Street's My
 * Information page — every one landed in the correct selector with the correct value — and
 * Workday still refused to advance. The bounded-retry path in executor.ts already re-discovers the
 * page and asks "is there anything NEW to fill or ask", but nothing anywhere reads WHY an
 * already-"completed" field might now be invalid in Workday's own eyes: `aria-invalid`, an inline
 * validation message, or a picker whose visible text was never actually selected as an option.
 * This module answers exactly that question, without guessing and without touching any control.
 *
 * SANITIZATION IS STRUCTURAL, NOT AN AFTERTHOUGHT. No control's actual value ever leaves the page —
 * only whether it HAS one and roughly how long it is. Labels, roles, and Workday's own validation
 * COPY (fixed UI strings like "Please select a valid option") are not candidate data and are kept,
 * since they are what makes the snapshot useful at all.
 */

export interface ValidationSnapshotEntry {
  tag: string;
  type: string | null;
  role: string | null;
  automationId: string | null;
  /** The visible label/legend text identifying the QUESTION — never the answer. */
  label: string | null;
  required: boolean;
  ariaRequired: boolean;
  ariaInvalid: boolean;
  ariaHaspopup: string | null;
  ariaControls: string | null;
  ariaExpanded: string | null;
  /** Presence and rough size only — the actual value is never captured. */
  hasValue: boolean;
  valueLength: number;
  disabled: boolean;
  /** offsetParent === null, or a zero-area box — the same test fieldDiscovery already uses to
   *  exclude invisible controls from being filled. */
  hidden: boolean;
  /** Text of whatever `aria-describedby` points at, when short enough to plausibly be Workday's
   *  own validation copy rather than unrelated page content. Fixed UI strings, not candidate data. */
  describedByText: string | null;
}

export interface ValidationSnapshot {
  url: string;
  heading: string | null;
  controls: ValidationSnapshotEntry[];
  /** Standalone page-level error/alert text (e.g. an error summary banner), if present. */
  pageErrors: string[];
}

/**
 * A raw string, evaluated as-is — same convention as COLLECT_CONTROLS_SCRIPT (fieldDiscovery.ts)
 * and documented at readAdvanceControlTexts (executor.ts): a named function PASSED to
 * `page.evaluate()` gets wrapped by the bundler's `__name` helper, which does not exist in the
 * browser context. A string has no such transform applied to it.
 */
const VALIDATION_SNAPSHOT_SCRIPT = `
  (() => {
    const isHidden = (el) => {
      const box = el.getBoundingClientRect();
      return el.offsetParent === null || (box.width === 0 && box.height === 0);
    };

    const labelFor = (el) => {
      const id = el.getAttribute("id");
      if (id) {
        const explicit = document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
        if (explicit && explicit.textContent && explicit.textContent.trim()) return explicit.textContent.trim().slice(0, 200);
      }
      const aria = el.getAttribute("aria-label");
      if (aria && aria.trim()) return aria.trim().slice(0, 200);
      const fieldset = el.closest("fieldset");
      const legend = fieldset && fieldset.querySelector("legend");
      if (legend && legend.textContent && legend.textContent.trim()) return legend.textContent.trim().slice(0, 200);
      const wrappingLabel = el.closest("label");
      if (wrappingLabel && wrappingLabel.textContent && wrappingLabel.textContent.trim()) return wrappingLabel.textContent.trim().slice(0, 200);
      return null;
    };

    const describedByText = (el) => {
      const raw = el.getAttribute("aria-describedby") || "";
      const ids = raw.split(/\\s+/).filter(Boolean);
      for (const id of ids) {
        const target = document.getElementById(id);
        const text = target && target.textContent ? target.textContent.trim() : "";
        if (text.length > 0 && text.length < 300) return text;
      }
      return null;
    };

    const nodes = [...document.querySelectorAll('input, select, textarea, [role="combobox"], [role="listbox"], [aria-invalid]')];

    const controls = nodes.map((el) => {
      const value = el.value || "";
      return {
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute("type"),
        role: el.getAttribute("role"),
        automationId: (el.closest("[data-automation-id]") && el.closest("[data-automation-id]").getAttribute("data-automation-id")) || el.getAttribute("data-automation-id"),
        label: labelFor(el),
        required: el.required === true,
        ariaRequired: el.getAttribute("aria-required") === "true",
        ariaInvalid: el.getAttribute("aria-invalid") === "true",
        ariaHaspopup: el.getAttribute("aria-haspopup"),
        ariaControls: el.getAttribute("aria-controls"),
        ariaExpanded: el.getAttribute("aria-expanded"),
        hasValue: value.length > 0,
        valueLength: value.length,
        disabled: el.disabled === true,
        hidden: isHidden(el),
        describedByText: describedByText(el),
      };
    });

    const pageErrors = [...document.querySelectorAll('[role="alert"], [data-automation-id*="error" i]')]
      .map((el) => (el.textContent || "").trim())
      .filter((text) => text.length > 0 && text.length < 300);

    return {
      url: location.href,
      heading: ((document.querySelector("h1, h2") || {}).textContent || "").trim().slice(0, 200) || null,
      controls,
      pageErrors,
    };
  })()
`;

export async function captureValidationSnapshot(page: Page): Promise<ValidationSnapshot> {
  return page.evaluate(VALIDATION_SNAPSHOT_SCRIPT);
}

/**
 * PHASE 9E — MULTISELECT OBSERVATION. What happened, structurally, right after
 * `selectComboboxOption` clicked one option in a picker/multiselect.
 *
 * WHY THIS EXISTS. "How Did You Hear About Us?" is filled by exactly this mechanism, and every
 * real run so far has recorded `field_filled` for it — yet Workday's own validation later reports
 * "0 items selected". This function answers, from the live DOM, whether the click actually
 * registered as a selection (aria-selected/aria-checked, a chip/token, a changed selected-count
 * string) or merely closed/reopened the input with no committed state — and whether Workday
 * exposes an explicit Done/Apply/Confirm control this engine has never clicked.
 *
 * SANITIZED THE SAME WAY captureValidationSnapshot IS: text of UI chrome and ARIA state only.
 * `selectedOptionText` is the one exception — it is the OPTION LABEL the candidate is being asked
 * to select (e.g. "Online Source"), which is Workday's own fixed choice-list wording, not
 * candidate-authored data, and is what proves WHICH option this evidence is about.
 */
export interface MultiselectCommitState {
  triggerAriaExpanded: string | null;
  /** Whatever text names the current selection state near the trigger (e.g. "0 items selected",
   *  "1 item selected") — Workday's own status wording, not a candidate value. */
  triggerStatusText: string | null;
  /** True if an element matching the clicked option's text still exists and now carries
   *  aria-selected="true" or aria-checked="true". */
  optionMarkedSelected: boolean;
  /** A nested checkbox/radio inside the matched option, if one exists, and its checked state. */
  optionHasNestedCheckbox: boolean;
  optionNestedCheckboxChecked: boolean | null;
  /** True if a chip/token/pill-like element containing the option's text now exists outside the
   *  option list itself (a common multiselect "selected items" rendering). */
  chipPresent: boolean;
  /** Any nearby button whose visible text reads as an explicit commit action, scoped to the
   *  smallest popup/listbox container, never the whole page. Text only — never assumed to exist. */
  commitButtonText: string | null;
  commitButtonAutomationId: string | null;
  /** Whether a `[role="listbox"]`/`[role="menu"]` popup is still present/visible in the DOM. */
  popupStillOpen: boolean;
}

const MULTISELECT_COMMIT_SCRIPT_TEMPLATE = `
  (() => {
    const optionText = __OPTION_TEXT__;
    const escaped = optionText.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&");
    const re = new RegExp("^\\\\s*" + escaped + "\\\\s*$");

    const isVisible = (el) => {
      const box = el.getBoundingClientRect();
      return el.offsetParent !== null && (box.width > 0 || box.height > 0);
    };

    const allOptionLike = [...document.querySelectorAll('[role="option"], [data-automation-id="menuItem"]')];
    const matched = allOptionLike.find((el) => re.test((el.textContent || "")));

    const optionMarkedSelected = matched
      ? matched.getAttribute("aria-selected") === "true" || matched.getAttribute("aria-checked") === "true"
      : false;
    const nestedCheckbox = matched ? matched.querySelector('input[type="checkbox"], input[type="radio"], [role="checkbox"]') : null;

    const chipCandidates = [...document.querySelectorAll('[data-automation-id*="chip" i], [class*="chip" i], [class*="token" i], [class*="tag" i]')];
    const chipPresent = chipCandidates.some((el) => re.test((el.textContent || "")) && isVisible(el));

    const popupEl = document.querySelector('[role="listbox"], [role="menu"]');
    const popupStillOpen = !!(popupEl && isVisible(popupEl));

    let commitButtonText = null;
    let commitButtonAutomationId = null;
    const commitWords = /\\b(done|apply|confirm|ok|close|save)\\b/i;
    const scope = popupEl || document.body;
    const nearbyButtons = [...scope.querySelectorAll("button")];
    for (const b of nearbyButtons) {
      const text = (b.textContent || "").trim();
      if (text && commitWords.test(text) && isVisible(b)) {
        commitButtonText = text.slice(0, 60);
        commitButtonAutomationId = b.getAttribute("data-automation-id");
        break;
      }
    }

    const trigger = document.querySelector('[data-automation-id="multiselectInputContainer"] input, [data-automation-id="multiselectInputContainer"]');
    const statusEl = trigger ? trigger.parentElement : null;
    const statusText = statusEl ? (statusEl.textContent || "").trim().slice(0, 100) : null;

    return {
      triggerAriaExpanded: trigger ? trigger.getAttribute("aria-expanded") : null,
      triggerStatusText: statusText || null,
      optionMarkedSelected,
      optionHasNestedCheckbox: !!nestedCheckbox,
      optionNestedCheckboxChecked: nestedCheckbox ? (nestedCheckbox.checked === true || nestedCheckbox.getAttribute("aria-checked") === "true") : null,
      chipPresent,
      commitButtonText,
      commitButtonAutomationId,
      popupStillOpen,
    };
  })()
`;

export async function captureMultiselectCommitState(page: Page, selectedOptionText: string): Promise<MultiselectCommitState> {
  const script = MULTISELECT_COMMIT_SCRIPT_TEMPLATE.replace("__OPTION_TEXT__", JSON.stringify(selectedOptionText));
  return page.evaluate(script);
}
