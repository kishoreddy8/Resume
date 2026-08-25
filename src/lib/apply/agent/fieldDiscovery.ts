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

export function discoverFields(controls: RawControl[]): DiscoveredField[] {
  const fields: DiscoveredField[] = [];

  for (const raw of controls) {
    const selector = selectorFor(raw);
    if (!selector) continue; // Unaddressable — see selectorFor.

    const label = cleanLabel(raw.labelText) ?? cleanLabel(raw.ariaLabel) ?? cleanLabel(raw.ancestorText ?? null);
    const kind = kindOf(raw);

    /* Search boxes and hidden helpers are page furniture, not questions. Matched on role rather
     * than on a blocklist of ids, so it holds across companies. */
    if (raw.type === "search") continue;
    if (kind === "unknown" && !label) continue;

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
export const COLLECT_CONTROLS_SCRIPT = `
  [...document.querySelectorAll("input, select, textarea")].map((el) => ({
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute("type"),
    id: el.id || null,
    name: el.getAttribute("name"),
    ariaLabel: el.getAttribute("aria-label"),
    role: el.getAttribute("role"),
    className: el.getAttribute("class"),
    automationId: el.getAttribute("data-automation-id"),
    labelText: (el.id && document.querySelector('label[for="' + el.id + '"]')?.textContent) || null,
    ancestorText: (el.closest("li, .application-question, .application-field, fieldset, [data-automation-id=formField]")
      ?.querySelector(".application-label, legend, label, .text")?.textContent || null),
    required: el.hasAttribute("required") || el.getAttribute("aria-required") === "true",
    options: el.tagName.toLowerCase() === "select"
      ? [...el.querySelectorAll("option")].map((o) => o.textContent?.trim() || "")
      : undefined,
  }))
`;
