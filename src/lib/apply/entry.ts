/**
 * PHASE 9E.2 — the application ENTRY stage, and the pure rules that govern it.
 *
 * THE PROBLEM THIS EXISTS FOR. A saved `apply_url` is not always the application form. On Workday
 * it is a job POSTING, with the form several navigations behind an Apply control. The engine used
 * to open that posting, discover zero fields, and fall through to READY_FOR_REVIEW — reporting a
 * prepared application that had never been opened. The zero-fill guard now catches that as an
 * honest failure; this module is what actually gets the run to the form.
 *
 * ENTRY IS NOT SUBMISSION, AND THE DISTINCTION IS STRUCTURAL. An entry control is clicked BEFORE
 * any field is filled — there is nothing to submit yet, by construction, and the executor only runs
 * this stage while `completed.length === 0`. That is the real safety property; the checks below are
 * defence in depth on top of it.
 *
 * SELECTOR-FIRST, NEVER TEXT-SEARCH. An entry step names an EXACT selector observed on a real form.
 * Nothing here ever searches the page for a button containing "Apply" and clicks the first hit —
 * that is precisely how an automation ends up clicking a final submit control.
 */

/** What an entry step is for. Governs consent policy — see `isSafeEntryStep`. */
export type EntryStepKind =
  /** A cookie/website technical notice that gates navigation. NOT an application consent. */
  | "dismiss_notice"
  /** A pre-form navigation control that opens the application (Workday's "Apply"). */
  | "enter_application";

export interface ApplicationEntryStep {
  /** The exact observed selector. Never a text query. */
  selector: string;
  /**
   * The control's visible text AS OBSERVED. Verified against the live control before clicking: if
   * the page has changed and this selector now carries different text, the run stops rather than
   * clicking something it has not seen. This is what keeps a stale selector from becoming a click
   * on whatever occupies that position today.
   */
  expectedText: string;
  kind: EntryStepKind;
  /** True when the control legitimately may not appear (a cookie notice already dismissed). */
  optional?: boolean;
}

/**
 * Meanings that can NEVER be an entry step, whatever an adapter claims.
 *
 * "Apply" is deliberately absent: on a job posting it is the control that OPENS the application,
 * and an adapter that observed it may declare it. Every meaning below, by contrast, describes
 * completing an application that has already been filled — none of them can be a pre-form
 * navigation, so declaring one is always a mistake and is refused rather than trusted.
 */
const NEVER_AN_ENTRY_MEANING = /\b(submit|finish|complete|send)\b/i;

export type EntryStepRejection =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Static validation of a declared step. Runs before any browser action, so a bad adapter contract
 * fails at the first opportunity rather than at a click.
 */
export function validateEntryStep(step: ApplicationEntryStep): EntryStepRejection {
  if (!step.selector || step.selector.trim().length === 0) {
    return { ok: false, reason: "an entry step must name an exact selector" };
  }
  if (!step.expectedText || step.expectedText.trim().length === 0) {
    return { ok: false, reason: `entry step ${step.selector} must declare the text it was observed carrying` };
  }
  if (NEVER_AN_ENTRY_MEANING.test(step.expectedText)) {
    return {
      ok: false,
      reason: `entry step ${step.selector} declares "${step.expectedText}", which means completing an application, not opening one`,
    };
  }
  return { ok: true };
}

/** Lowercase, collapse whitespace, fold "&". Matches the advance classifier's own normalisation so
 *  the two agree about what a control "says". */
export function normalizeEntryText(raw: string | null | undefined): string {
  return (raw ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Does the live control still say what the adapter observed?
 *
 * Deliberately an EQUALITY check on normalised text, not a substring test: "Apply" must not match
 * "Apply Now and Submit". A control whose text has drifted is a control this adapter has not seen.
 */
export function entryControlTextMatches(observed: string, actualTexts: readonly (string | null | undefined)[]): boolean {
  const want = normalizeEntryText(observed);
  if (want.length === 0) return false;
  return actualTexts.map(normalizeEntryText).some((t) => t === want);
}

/**
 * The outcome of the whole entry stage.
 *
 * Deliberately NOT a parallel state machine. Only `PROCEED` continues; every other value is turned
 * into the run's existing FAILED status with a specific reason by the executor. CAPTCHA/MFA/
 * email-verification/login walls are NOT represented here at all — the executor's existing blocking
 * detection and `ensureAuthenticated` run on whatever page entry lands on, which is exactly the
 * handoff Part 10 asks for and avoids a second copy of that logic.
 */
export type EntryOutcome =
  /** No entry contract declared — behaviour is byte-identical to before this stage existed. */
  | "NO_ENTRY_CONTRACT"
  /** Entry finished (or had nothing to do); the normal pipeline takes over from here. */
  | "PROCEED"
  /** A required step's control was not on the page. */
  | "ENTRY_STEP_MISSING"
  /** The control was there but its text is not what was observed. */
  | "ENTRY_CONTROL_CHANGED"
  /** The adapter declared a step that can never be an entry control. */
  | "ENTRY_CONTRACT_INVALID"
  /** A click produced no observable transition. */
  | "ENTRY_NO_TRANSITION"
  /** The declared sequence exceeded its bound. */
  | "ENTRY_STEP_LIMIT";

export const ENTRY_OUTCOME_REASON: Record<Exclude<EntryOutcome, "PROCEED" | "NO_ENTRY_CONTRACT">, string> = {
  ENTRY_STEP_MISSING:
    "The application could not be opened: a control this ATS adapter expects on the way to the form was not present.",
  ENTRY_CONTROL_CHANGED:
    "The application could not be opened: a control on the way to the form no longer says what this adapter observed, so it was not clicked.",
  ENTRY_CONTRACT_INVALID:
    "This ATS adapter declares an application-entry step that is not a valid pre-form control; nothing was clicked.",
  ENTRY_NO_TRANSITION:
    "The application could not be opened: clicking through to the form produced no change, so it was not retried.",
  ENTRY_STEP_LIMIT:
    "The application could not be opened within this ATS adapter's own entry-step bound; stopped rather than continuing.",
};

/** The engine's ceiling on entry steps. An adapter may declare fewer, never more. Observed Workday
 *  entry is three controls (notice, Apply, Apply Manually); this leaves headroom without ever
 *  allowing a long click-through. */
export const ENTRY_HARD_CAP = 5;

export function boundEntrySteps(adapterMax: number | undefined): number {
  if (adapterMax === undefined || !Number.isFinite(adapterMax)) return ENTRY_HARD_CAP;
  return Math.min(Math.max(1, Math.floor(adapterMax)), ENTRY_HARD_CAP);
}

/**
 * Is there meaningful evidence that a real APPLICATION FORM has been reached?
 *
 * Deliberately stricter than "any input exists". A cookie checkbox, a site search box, a newsletter
 * signup, or a login form are all inputs, and none of them means the application is open. The test
 * is: at least `minimum` controls that are plausible application fields, ignoring the ones that are
 * page furniture or authentication. Used only for reporting/diagnosis — the authoritative check
 * remains the executor's zero-fill guard, which fails the run when nothing was actually filled.
 */
export function looksLikeApplicationForm(
  fields: readonly { kind: string; label: string | null; id: string | null }[],
  minimum = 2
): boolean {
  const AUTH_OR_FURNITURE = /(^|[^a-z])(email|password|search|newsletter|subscribe|cookie|beecatcher)([^a-z]|$)/i;
  const plausible = fields.filter((f) => {
    if (f.kind === "unknown") return false;
    const identity = `${f.id ?? ""} ${f.label ?? ""}`;
    return !AUTH_OR_FURNITURE.test(identity);
  });
  return plausible.length >= minimum;
}
