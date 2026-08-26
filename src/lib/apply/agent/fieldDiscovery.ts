import type { DiscoveredField } from "./types";

/**
 * Turning a page's form controls into something the planner can reason about.
 *
 * SELECTORS ARE SEMANTIC, NOT POSITIONAL. Real Greenhouse forms carry stable ids — `first_name`,
 * `email`, `resume`, `cover_letter` — and proper `<label for>` associations, verified by inspecting
 * a live posting. An nth-child path would break the first time a company adds an optional question,
 * and break silently, which is worse: the agent would fill the wrong field rather than fail.
 *
 * The browser-side half of this is a few lines of DOM reading. Everything that decides anything is
 * pure and lives here, so it can be tested against a captured snapshot of a real form.
 */

/** The DOM shape the browser hands over. Matches what a page.evaluate() can cheaply collect. */
export interface RawControl {
  tag: string;
  type: string | null;
  id: string | null;
  name: string | null;
  ariaLabel: string | null;
  labelText: string | null;
  /** The `role` attribute. Modern searchable-select libraries (react-select and similar) render an
   *  ordinary `<input>` with `role="combobox"` rather than a native `<select>` — without this, that
   *  control is indistinguishable from a plain text field. */
  role?: string | null;
  /** PHASE 9 — the `data-automation-id` attribute. Workday's only tenant-stable control identity;
   *  its `id`s are generated per render. Null/absent everywhere the attribute isn't used. */
  automationId?: string | null;
  /** PHASE 9E — the owning `<fieldset>`'s `<legend>` text, when there is one. Captured EXPLICITLY
   *  rather than inferred from `ancestorText`, because for a radio group the legend is the QUESTION
   *  while each member's own `<label for>` is only an OPTION. Observed on a real Workday tenant:
   *  `<fieldset><legend>Have you previously worked for our Organization?</legend>` wrapping
   *  `<label for=..>Yes</label><input type=radio>` — reading the option label as the question is how
   *  the Human Question Center ends up asking the user a question titled "Yes". */
  groupLegend?: string | null;
  /** The `class` attribute, as a generic secondary signal only — react-select's own default class
   *  names (e.g. "…select__input…") are a library convention used across many ATS boards, not a
   *  Celigo-specific hack. Never the primary signal; `role="combobox"` is checked first. */
  className?: string | null;
  /**
   * Text from the element that visually captions this control, when there is no <label for>.
   *
   * Needed because real forms differ more than they look: Greenhouse labels everything properly,
   * while Lever gives its core fields NO label at all and puts custom-question wording in a
   * surrounding element. Without this, every Lever question would arrive unlabelled and the run
   * would block on all of them — including ones the adapter knows by name.
   */
  ancestorText?: string | null;
  required: boolean;
  options?: string[];
  /** PHASE 9E — VALIDATION OBSERVATION. Some Workday tenant fields are triggered by a `<button>`,
   *  not an `<input role="combobox">` — observed on State Street's own tenant for "State" and
   *  "Phone Device Type" (`data-automation-id="formField-countryRegion"` /
   *  "formField-phoneType"), each carrying `aria-haspopup="listbox"` and no `role` at all. Neither
   *  was ever matched by `role === "combobox"`, so both were completely invisible to discovery —
   *  never filled, never asked about, and never counted toward "nothing more could be safely
   *  filled" — which is exactly why a real run filled everything it could see and Workday still
   *  refused to advance. See kindOf below. */
  ariaHaspopup?: string | null;
}

/** react-select's own generated class prefix — a library convention, not any one company's markup. */
const COMBOBOX_CLASS_PATTERN = /\bselect__input\b/;

function kindOf(raw: RawControl): DiscoveredField["kind"] {
  if (raw.tag === "textarea") return "textarea";
  if (raw.tag === "select") return "select";
  // Checked before the type-based switch below: a combobox input's own `type` is ordinarily "text"
  // (or absent), which would otherwise fall through to the generic text case and be filled the same
  // unsafe way as a free-text box — exactly the GAP-2 bug observed on a real Greenhouse form.
  if (raw.role === "combobox") return "combobox";
  if (raw.className && COMBOBOX_CLASS_PATTERN.test(raw.className)) return "combobox";
  // PHASE 9E — VALIDATION OBSERVATION. Workday's "State" and "Phone Device Type" are real
  // <button>s with aria-haspopup="listbox" and no role at all — a button-triggered listbox is the
  // same trigger-plus-popup shape as an input-based combobox, just a different tag. Recognised by
  // the ARIA contract, not by tag alone, so an ordinary submit/cancel button (aria-haspopup absent)
  // is never swept in.
  if (raw.tag === "button" && raw.ariaHaspopup === "listbox") return "combobox";
  switch (raw.type) {
    case "email":
      return "email";
    case "tel":
      return "tel";
    case "file":
      return "file";
    case "checkbox":
      return "checkbox";
    case "radio":
      return "radio";
    case "date":
      return "date";
    case "month":
      return "month";
    case "text":
    case "search":
    case null:
      return raw.type === "text" ? "text" : "unknown";
    default:
      return "unknown";
  }
}

/** Trailing asterisks mark required fields on most ATS forms; they are not part of the question. */
function cleanLabel(text: string | null): string | null {
  if (!text) return null;
  const cleaned = text.replace(/\s*\*\s*$/, "").replace(/\s+/g, " ").trim();
  return cleaned.length > 0 ? cleaned : null;
}

/** Escapes a value for safe embedding inside a double-quoted CSS attribute selector. The only two
 *  characters that could break out of the quotes — or be read as selector syntax — are the quote
 *  itself and the backslash; both are escaped, and nothing else is altered. Never interpolates a
 *  raw, unescaped value into a selector string. */
export function escapeAttributeValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * A selector that will find this control again after a reload.
 *
 * Returns null when neither an id nor a name exists. A field the agent cannot reliably re-find is
 * one it should not touch — silently acting on the wrong element is the failure mode worth
 * avoiding, and there is always the option of asking the user.
 */
export function selectorFor(raw: RawControl): string | null {
  // PHASE 9 — a data-automation-id outranks a GENERATED id. Workday renders ids like
  // "input--uid42" that change between page loads, while the automation id
  // ("legalNameSection_firstName") is the tenant-stable contract, so a control carrying both is
  // re-found by the automation id. Stable ids (Greenhouse's `first_name` etc.) still win because a
  // control carrying BOTH is addressed identically by either, and #id is the cheaper query. The
  // generated-id test is deliberately narrow — "--uid" (Workday's double-dash uid suffix) or an
  // "input-<n>" prefix — so an ordinary stable id that merely contains "uid"
  // (e.g. "candidate-uid-display") is never demoted.
  if (raw.id && /^[A-Za-z][\w-]*$/.test(raw.id) && !/--uid|^input-\d/.test(raw.id)) return `#${raw.id}`;
  if (raw.automationId) return `[data-automation-id="${escapeAttributeValue(raw.automationId)}"]`;
  if (raw.id) {
    // A generated id with NO automation id lands here and still yields #input--uid42 — the last
    // resort, because an addressable-now selector beats refusing the field. It is NOT
    // reload-stable, and nothing here claims it is.
    if (/^[A-Za-z][\w-]*$/.test(raw.id)) return `#${raw.id}`;
    // A real id that doesn't parse as a bare CSS identifier — most commonly a numeric id like
    // Greenhouse's demographic controls ("16768"), which `#16768` cannot address at all without
    // CSS's own digit-escaping rules. An attribute selector addresses it exactly instead, with the
    // value safely escaped rather than interpolated raw.
    return `[id="${escapeAttributeValue(raw.id)}"]`;
  }
  if (raw.name) return `[name="${escapeAttributeValue(raw.name)}"]`;
  return null;
}

/**
 * PHASE 9E — a radio GROUP is one question, not one question per member.
 *
 * THE SEMANTIC RULE. For a radio group the `<legend>` is the QUESTION and each member's own
 * `<label for>` is an OPTION. Reading the option label as the question is how the Human Question
 * Center ends up asking the user a question literally titled "Yes" — observed against a real
 * Workday tenant, where every radio carries its own `<label for>`. Greenhouse and Lever radios carry
 * no per-option label, so `ancestorText` already surfaced their legend correctly; this rule makes
 * that behaviour explicit and universal rather than an accident of label absence.
 *
 * THE CARDINALITY RULE. Members are grouped by the `name` attribute — HTML's own definition of a
 * radio group — so five options produce ONE DiscoveredField, one planning decision, and one human
 * question. A radio with no `name` cannot be grouped and remains its own field, exactly as before.
 *
 * The emitted field's selector is the FIRST member's. That is deliberate and sufficient: the
 * executor's radio branch resolves the whole group from that element's `name` and matches the
 * approved answer against every member's label/value, so a group-level selector addresses the group.
 */
function radioGroupKey(raw: RawControl): string | null {
  return raw.name && raw.name.trim().length > 0 ? raw.name : null;
}

export function discoverFields(controls: RawControl[]): DiscoveredField[] {
  const fields: DiscoveredField[] = [];
  /** name -> index in `fields`, for radio groups already emitted. */
  const emittedRadioGroups = new Map<string, number>();

  for (const raw of controls) {
    const selector = selectorFor(raw);
    if (!selector) continue; // Unaddressable — see selectorFor.

    const kind = kindOf(raw);

    /* Search boxes and hidden helpers are page furniture, not questions. Matched on role rather
     * than on a blocklist of ids, so it holds across companies. */
    if (raw.type === "search") continue;

    /* PHASE 9E.2 — a password input is AUTHENTICATION, never application data.
     *
     * Found by the first real Workday run: a mis-detected auth state let the engine treat a sign-in
     * form as the application form, fill the email, and then ask the operator for "Password"
     * through the Human Question Center — where any answer would have been persisted into the run
     * checkpoint, writing a password into SQLite. `ensureAuthenticated`'s `fillSecret` is the only
     * thing that may ever type into a password field, and it addresses one by explicit adapter
     * selector, never through discovery. Dropping these here means a password can never enter a
     * FieldPlan, a checkpoint, an audit event, the answer vault, or a review. */
    if (raw.type === "password") continue;

    /* The option's own text, for a radio member. Not the question. */
    const ownLabel = cleanLabel(raw.labelText) ?? cleanLabel(raw.ariaLabel);

    if (kind === "radio") {
      const groupKey = radioGroupKey(raw);
      /* Legend first: it is the question. Only when a group has no legend at all does the existing
       * fallback chain apply, preserving pre-9E behaviour for markup that never had one. */
      const question = cleanLabel(raw.groupLegend ?? null) ?? cleanLabel(raw.ancestorText ?? null) ?? ownLabel;
      if (groupKey !== null) {
        const existing = emittedRadioGroups.get(groupKey);
        if (existing !== undefined) {
          /* Fold this member into the group already emitted: contribute its option text, and let a
           * required member make the whole group required. */
          const target = fields[existing]!;
          if (ownLabel) target.options = [...(target.options ?? []), ownLabel];
          if (raw.required) target.required = true;
          continue;
        }
        emittedRadioGroups.set(groupKey, fields.length);
      }
      if (!question && !ownLabel) continue;
      fields.push({
        selector,
        kind,
        label: question ?? null,
        id: raw.id,
        name: raw.name,
        ...(raw.automationId ? { automationId: raw.automationId } : {}),
        required: raw.required,
        ...(ownLabel ? { options: [ownLabel] } : {}),
      });
      continue;
    }

    const label = ownLabel ?? cleanLabel(raw.ancestorText ?? null);
    if (kind === "unknown" && !label) continue;

    /* PHASE 9E.3 — FORM-CONTROL SCOPING. A button-driven listbox with NO discoverable label is page
     * CHROME, not a question. Observed directly on real Run 23 (State Street, 2026-08-25):
     * `languageSelectorButton` and `settingsSelectorButton` — both `<button aria-haspopup="listbox">`
     * with no `<label for>`, no `aria-label`, and no recognizable field-container ancestor — were
     * swept in by the button-picker discovery added for State/Phone Device Type and surfaced as two
     * junk Human Questions, while the real form's fields were never reached at all. Both of THOSE
     * real fields carry a genuine `<label for>` (see BUTTON-PICKER-05). This is exactly the same
     * "no label, no question" rule already applied to `kind === "unknown"` above, extended to the
     * one other kind capable of matching page chrome. UNIVERSAL, not Workday-specific: it depends
     * only on label presence, so it costs Greenhouse and Lever nothing (neither renders this shape)
     * and needs no adapter hint, id blacklist, or Workday-specific selector. Scoped to `tag ===
     * "button"` only — an input-based combobox (Greenhouse/Lever's react-select shape) is untouched,
     * since it never matched page chrome in the first place. */
    if (kind === "combobox" && raw.tag === "button" && !label) continue;

    fields.push({
      selector,
      kind,
      label,
      id: raw.id,
      name: raw.name,
      ...(raw.automationId ? { automationId: raw.automationId } : {}),
      required: raw.required,
      ...(raw.options && raw.options.length > 0 ? { options: raw.options } : {}),
    });
  }

  return fields;
}

/** The browser-side snippet, kept beside the parser it feeds so the two cannot drift. */
/**
 * PHASE 9E — the `automationId` read walks ANCESTORS, not just the element.
 *
 * Observed on a real Workday tenant (2026-08-25): Workday does NOT put `data-automation-id` on the
 * <input>. It sits on a wrapper div up to three levels above it
 * (`formField-legalName--firstName`), while the input itself carries a stable semantic id
 * (`name--legalName--firstName`). Phase 9A read the attribute off the element and therefore saw
 * `null` on every single Workday control — the automation-id path was dead code against the very
 * ATS it was written for.
 *
 * The walk is bounded to 4 hops so it can never climb out of a field's own wrapper into a
 * page-level container and mislabel every control with the same id. An element that carries the
 * attribute itself still wins immediately, so Greenhouse/Lever behaviour is unchanged (neither
 * uses the attribute at all).
 *
 * `ancestorText` matches `formField*` by PREFIX for the same reason: Workday's wrappers are
 * `formField-city`, never a bare `formField`, so the previous exact match never fired.
 */
export const COLLECT_CONTROLS_SCRIPT = `
  [...document.querySelectorAll('input, select, textarea, button[aria-haspopup="listbox"]')].filter((el) => {
    /* PHASE 9E.2 — an INVISIBLE control is not a question.
     *
     * Found by the real Workday run: after authenticating, the sign-in form's inputs remain in the
     * DOM, merely hidden. Discovery picked one up (its generated id "input-6" was demoted, so its
     * "email" automation id became the selector), the planner filled it from the profile, and
     * page.fill then hung for 30 seconds on an element that could never be typed into before
     * failing the whole run.
     *
     * A zero-area rect covers display:none, visibility-collapsed, and detached-but-referenced
     * nodes alike, which is exactly the class of leftover this must exclude. Anything a human can
     * actually see and answer has a non-zero box. */
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }).map((el) => ({
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute("type"),
    id: el.id || null,
    name: el.getAttribute("name"),
    ariaLabel: el.getAttribute("aria-label"),
    ariaHaspopup: el.getAttribute("aria-haspopup"),
    role: el.getAttribute("role"),
    className: el.getAttribute("class"),
    automationId: (() => {
      let node = el;
      let hops = 0;
      while (node && hops < 4) {
        const found = node.getAttribute && node.getAttribute("data-automation-id");
        if (found) return found;
        node = node.parentElement;
        hops++;
      }
      return null;
    })(),
    labelText: (el.id && document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id) + '"]')?.textContent) || null,
    groupLegend: (el.closest("fieldset")?.querySelector("legend")?.textContent) || null,
    ancestorText: (el.closest("li, .application-question, .application-field, fieldset, [data-automation-id^=formField]")
      ?.querySelector(".application-label, legend, label, .text")?.textContent || null),
    required: el.hasAttribute("required") || el.getAttribute("aria-required") === "true",
    options: el.tagName.toLowerCase() === "select"
      ? [...el.querySelectorAll("option")].map((o) => o.textContent?.trim() || "")
      : undefined,
  }))
`;
