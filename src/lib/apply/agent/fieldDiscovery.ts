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

function kindOf(raw: RawControl): DiscoveredField["kind"] {
  if (raw.tag === "textarea") return "textarea";
  if (raw.tag === "select") return "select";
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

/**
 * A selector that will find this control again after a reload.
 *
 * Returns null when neither an id nor a name exists. A field the agent cannot reliably re-find is
 * one it should not touch — silently acting on the wrong element is the failure mode worth
 * avoiding, and there is always the option of asking the user.
 */
export function selectorFor(raw: RawControl): string | null {
  if (raw.id && /^[A-Za-z][\w-]*$/.test(raw.id)) return `#${raw.id}`;
  if (raw.name) return `[name="${raw.name}"]`;
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
    labelText: (el.id && document.querySelector('label[for="' + el.id + '"]')?.textContent) || null,
    ancestorText: (el.closest("li, .application-question, .application-field, fieldset")
      ?.querySelector(".application-label, legend, label, .text")?.textContent || null),
    required: el.hasAttribute("required") || el.getAttribute("aria-required") === "true",
    options: el.tagName.toLowerCase() === "select"
      ? [...el.querySelectorAll("option")].map((o) => o.textContent?.trim() || "")
      : undefined,
  }))
`;
