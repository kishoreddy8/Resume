import type { AtsAdapter } from "../agent/types";

/**
 * PHASE 9B — pure decisions for the multi-page application walk.
 *
 * THIS MODULE DECIDES NOTHING ABOUT ANSWERS. What may be typed into a field stays with planFields
 * and the vault. What lives here is the navigation half of safety: whether a control may be
 * CLICKED to advance, whether a page is the review page or a login wall, how many pages a walk may
 * span, and whether a click actually moved the application forward. All of it is pure so the
 * never-submit rules have tests that do not depend on a browser — the same discipline as the
 * planner.
 */

// ── advance-control classification ───────────────────────────────────────────────────────────────

export type AdvanceControlClassification = "safe_advance" | "final_action" | "unknown";

/**
 * Final-action vocabulary, matched as WHOLE WORDS in the normalised control text. Token-based
 * rather than a literal phrase list so "Submit", "Submit Application", "Finish & Submit",
 * "Complete My Application" and "Send application" are all caught by the same five meanings.
 * Checked FIRST: a control that mixes vocabularies ("Save and Submit") is final, never safe.
 */
const FINAL_ACTION_TOKEN = /\b(submit|finish|complete|send|apply)\b/;

/**
 * The ONLY texts the engine may auto-click, after normalisation. A closed allowlist, not a
 * heuristic: anything outside it is "unknown", and unknown is never clicked. Deliberately short —
 * a missing safe phrase costs one manual click; a wrong entry could send an application.
 */
const SAFE_ADVANCE_TEXT = new Set([
  "next",
  "next step",
  "next page",
  "continue",
  "proceed",
  "save and continue",
  "save and proceed",
]);

/** Lowercase, fold "&" to "and", strip everything but letters/digits/spaces, collapse whitespace.
 *  Turns "Save & Continue →" into "save and continue". Nothing semantic happens here. */
export function normalizeControlText(raw: string | null | undefined): string {
  return (raw ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Classify one advance control from every text the page offers for it (visible text, aria-label,
 * value, title). Conservative by construction:
 *
 *   - ANY text carrying a final-action meaning → "final_action". One dangerous reading outranks
 *     any number of safe ones.
 *   - Otherwise at least one text on the safe allowlist → "safe_advance".
 *   - Otherwise — including a control with no readable text at all — → "unknown".
 *
 * The executor clicks ONLY "safe_advance". "final_action" and "unknown" both mean DO NOT CLICK;
 * they differ only in what the audit trail records.
 */
export function classifyAdvanceControl(texts: readonly (string | null | undefined)[]): AdvanceControlClassification {
  const normalized = texts.map(normalizeControlText).filter((t) => t.length > 0);
  if (normalized.length === 0) return "unknown";
  if (normalized.some((t) => FINAL_ACTION_TOKEN.test(t))) return "final_action";
  if (normalized.some((t) => SAFE_ADVANCE_TEXT.has(t))) return "safe_advance";
  return "unknown";
}

// ── page markers ─────────────────────────────────────────────────────────────────────────────────

/** Case-insensitive substring test of adapter-supplied markers against page text. Markers are
 *  lowercased defensively even though the AtsAdapter contract already asks for lowercase. */
export function matchesAnyMarker(pageText: string, markers: readonly string[]): boolean {
  if (markers.length === 0) return false;
  const lower = pageText.toLowerCase();
  return markers.some((m) => m.length > 0 && lower.includes(m.toLowerCase()));
}

// ── page bound ───────────────────────────────────────────────────────────────────────────────────

/** The engine's own ceiling. No legitimate application flow observed anywhere near it; a redirect
 *  loop hits it quickly. An adapter may only lower it, never raise it. */
export const MULTI_PAGE_HARD_CAP = 10;

export function boundMaxPages(adapterMax: number | undefined): number {
  if (adapterMax === undefined || !Number.isFinite(adapterMax)) return MULTI_PAGE_HARD_CAP;
  return Math.min(Math.max(1, Math.floor(adapterMax)), MULTI_PAGE_HARD_CAP);
}

// ── adapter contract resolution ──────────────────────────────────────────────────────────────────

export interface MultiPageConfig {
  nextSelector: string;
  reviewMarkers: string[];
  loginMarkers: string[];
  maxPages: number;
}

/**
 * The one gate for multi-page behavior: an adapter WITHOUT nextPageSelector gets null, and the
 * executor's page loop collapses to the exact single-page flow that existed before Phase 9B.
 * Greenhouse and Lever declare none of these members, so their behavior cannot change.
 */
export function resolveMultiPageConfig(adapter: AtsAdapter | null | undefined): MultiPageConfig | null {
  if (!adapter?.nextPageSelector) return null;
  return {
    nextSelector: adapter.nextPageSelector(),
    reviewMarkers: (adapter.reviewPageMarkers?.() ?? []).map((m) => m.toLowerCase()),
    loginMarkers: (adapter.loginWallMarkers?.() ?? []).map((m) => m.toLowerCase()),
    maxPages: boundMaxPages(adapter.maxPages?.()),
  };
}

// ── transition evidence ──────────────────────────────────────────────────────────────────────────

/** What one page looks like, for the sole purpose of telling "moved on" from "still here". */
export interface PageFingerprint {
  url: string;
  /** Identities of the form fields present (inputs/selects/textareas, buttons excluded). */
  fieldIds: string[];
  /** Button texts — the tiebreaker for a page with no form fields at all. */
  buttonTexts: string[];
}

/**
 * Whether a Next click actually advanced the application.
 *
 * The rule: a real page change makes the PREVIOUS page's fields disappear (SPA swap) or the URL
 * change (navigation). A validation failure does neither — it keeps every old field and ADDS error
 * indicators/fields — so "new controls appeared but every old one is still here" is deliberately
 * NOT a transition: it is the same page complaining, and treating it as progress would
 * mis-increment the page count and skip the page's unresolved questions.
 */
export function hasPageAdvanced(before: PageFingerprint, after: PageFingerprint): boolean {
  if (before.url !== after.url) return true;
  if (before.fieldIds.length === 0) {
    /* A page with no form fields (rare interstitial): fall back to field appearance or the
     * buttons changing. */
    return after.fieldIds.length > 0 || before.buttonTexts.join("\x00") !== after.buttonTexts.join("\x00");
  }
  return before.fieldIds.some((id) => !after.fieldIds.includes(id));
}
