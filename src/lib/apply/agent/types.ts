import type { SourceType } from "@/types";
import type { AnswerSource, QuestionType } from "../questionTypes";
import type { AdapterAuthConfig } from "../auth";
import type { ApplicationEntryStep } from "../entry";

/**
 * The agent contract, split so the decisions are testable without a browser.
 *
 * A browser reads a page into `DiscoveredField[]`, and everything that DECIDES anything — what a
 * field is, whether it may be filled, what value to use, when to stop and ask — is a pure function
 * over that array. The safety rules therefore have tests that do not depend on a live website, and
 * a rule cannot be quietly bypassed by an adapter doing its own thing.
 */

/** One form control, as read from a page. Deliberately flat and serialisable — it is checkpointed. */
export interface DiscoveredField {
  /** A selector that will find this control again. Prefer #id; see fieldDiscovery for why. */
  selector: string;
  kind: "text" | "email" | "tel" | "textarea" | "select" | "combobox" | "checkbox" | "radio" | "file" | "date" | "month" | "unknown";
  /** The visible label, or the accessible name. This is what gets matched against questions. */
  label: string | null;
  id: string | null;
  name: string | null;
  /** PHASE 9 — the `data-automation-id` attribute, when present. Workday's ONLY stable control
   *  identity: its `id`s are per-render generated ("input--uid42"), while automation ids
   *  ("legalNameSection_firstName") are the tenant-stable contract its own test tooling uses.
   *  Absent on ATS platforms that don't use the attribute — everything else is unchanged. */
  automationId?: string | null;
  required: boolean;
  /** Options for a select/radio, so an answer can be checked against what the form allows. */
  options?: string[];
}

/**
 * One human question collected for a batch pause.
 *
 * The executor collects ALL required unresolved questions into one batch rather than pausing on
 * each individually. This object carries everything the UI needs to render a control and everything
 * the answer route needs to validate, save, and resume.
 *
 * Stored in checkpoint.humanQuestions — must remain JSON-serialisable.
 */
export interface HumanQuestion {
  /** Stable DOM identity: field.id → field.name → field.selector. Used to match submitted answers. */
  id: string;
  selector: string;
  label: string;
  canonicalKey: string | null;
  questionType: QuestionType | null;
  required: boolean;
  kind: DiscoveredField["kind"];
  /** Employer-provided options when reliably available (select / radio / small combobox). */
  options: string[] | null;
  reason: string;
}

/**
 * A candidate-approved answer scoped strictly to the current ApplicationRun.
 *
 * PROVENANCE: The candidate explicitly answered this question during this run (USER_INTERVENTION).
 * This answer may be used to fill matching fields for THIS run even when canonicalKey is null
 * (i.e. custom/unrecognised employer screening questions), without polluting the global Answer Vault.
 */
export interface RunApprovedAnswer {
  questionId: string;
  selector: string;
  label: string;
  answer: string;
  canonicalKey: string | null;
  questionType: QuestionType | null;
}

/** What the agent decided to do with one field. Every fill carries its provenance. */
export type FieldPlan =
  | {
      action: "fill";
      field: DiscoveredField;
      value: string;
      source: AnswerSource;
      canonicalKey: string | null;
      /**
       * Present only on `location_city` fills. The raw profile location string ("Dallas, TX")
       * carried to the executor so the combobox normaliser can map a bare city to the canonical
       * ATS option ("Dallas, Texas, United States") when exact-match fails.
       */
      locationContext?: string;
      /**
       * Present only on `phone_country_code` fills. The candidate's country name context ("United States")
       * carried to the executor so the combobox normaliser can disambiguate shared dialing prefixes (+1 for US vs Canada).
       */
      phoneCountryContext?: string;
    }
  | { action: "upload"; field: DiscoveredField; filePath: string; source: AnswerSource }
  | { action: "ask"; field: DiscoveredField; question: string; reason: string; questionType: QuestionType | null }
  | { action: "skip"; field: DiscoveredField; reason: string };

/** PHASE 9 — one authoritative employment entry, verbatim from the candidate profile. Only the
 *  facts the profile actually records: employer, title, dates. Location/manager/salary/reason-for-
 *  leaving are NOT here because the profile does not record them — a form asking for one gets
 *  NEEDS_USER_INPUT, never a fabricated value. */
export interface EmploymentEntry {
  employer: string;
  title: string;
  /** "YYYY-MM" as the profile stores it, or null. */
  startDate: string | null;
  /** null means current role. */
  endDate: string | null;
}

/** PHASE 9 — one authoritative education entry. Graduation dates are deliberately absent: the
 *  candidate profile does not record them, and this system never invents one. */
export interface EducationEntry {
  level: string;
  field: string;
  institution: string;
}

export interface AdapterContext {
  candidateId: number;
  /** Verbatim contact facts. Never derived, never guessed — see resolveCandidateContact. */
  contact: { name: string; email: string; phone: string; location: string; linkedin?: string; github?: string };
  resumePath: string | null;
  coverLetterPath: string | null;
  /** PHASE 9D — employment history (chronological, newest first), sourced from
   *  `src/db/queries/candidateApplicationProfile.ts`'s `listEmployment`, which starts empty and is
   *  never auto-populated (see that module's own doc comment for why). Consumed NARROWLY by
   *  `planFields.ts`'s `employmentValueFor` for flat single-field questions ("Current Employer",
   *  "Current Job Title") only — a multi-entry, repeatable employment SECTION (Workday's own
   *  per-entry sub-form) is adapter-specific UI structure this generic layer does not attempt to
   *  solve. Optional and additive — absent behaves exactly as before: history fields become
   *  questions, never guesses. */
  employment?: EmploymentEntry[];
  /** PHASE 9D — education entries, same source/scope/additive contract as employment; see
   *  `educationValueFor` in planFields.ts. */
  education?: EducationEntry[];
}

/**
 * An application-form adapter.
 *
 * SCOPE: navigate, fill, upload, pause, review. It does NOT identify or discover an ATS — that is
 * the existing connector layer's job, and the job record already carries the answer in
 * `source_type`. An adapter is selected BY that identity rather than re-deriving it from a URL;
 * a second detector would be a second opinion, and the two would eventually disagree about the
 * same posting.
 */
export interface AtsAdapter {
  /** The canonical SourceType this adapter automates. Matches the job record's own value. */
  readonly sourceType: SourceType;
  /** Fields this ATS names consistently. A shortcut, never a form template — see each adapter. */
  fieldSelectorHints(): Record<string, string>;

  // --- PHASE 9 — optional multi-page capabilities (CONTRACT ONLY — not yet consumed) --------------
  // Every member below is an OPTIONAL contract field reserved for the FUTURE multi-page application
  // engine. The current engine reads NONE of them: an adapter declaring them today changes nothing,
  // and one that omits them (Greenhouse, Lever) runs exactly the single-page flow that existed
  // before this phase. When the multi-page executor slice lands, it will gate every multi-page
  // behavior on their presence and never branch on ATS-specific DOM selectors itself.

  /** Selector for the control that advances to the next page of a multi-page application. The
   *  future multi-page executor will click it ONLY after verifying the control's visible text is
   *  not a submit action — that final-submit/advance guard ships with that slice, not here. Omit
   *  for single-page ATS forms. */
  nextPageSelector?(): string;
  /** Lowercased page-text markers that identify the final review page. In the future multi-page
   *  walk, reaching a page matching any of these will end the walk at READY_FOR_REVIEW — the walk
   *  will never advance past review. */
  reviewPageMarkers?(): string[];
  /**
   * PHASE 9E — a STRUCTURAL review-page test: a selector whose mere presence means "this is the
   * review page". Checked in addition to `reviewPageMarkers`, and needed wherever page TEXT cannot
   * express the distinction.
   *
   * Workday is exactly that case. Its step navigator renders every step name — "Review" included —
   * on EVERY page, so any text marker matching "review" fires on page 1 and would declare the very
   * first page the review page. What distinguishes the real review page is structural: Workday
   * marks the active step `progressBarActiveStep` and every other step `progressBarInactiveStep`,
   * so "the ACTIVE step is Review" is expressible as a selector and nothing else.
   *
   * Evaluated with the browser's own selector engine, so Playwright text pseudo-classes such as
   * `:has-text(...)` are available to an adapter that needs them.
   */
  reviewPageSelector?(): string;
  /** Lowercased page-text/DOM markers of this ATS's login/account wall, to be merged into the
   *  generic blocking detector's own signals by the future multi-page engine. Such a run will stop
   *  with ACCOUNT_REQUIRED; nothing automates account creation or credentials. */
  loginWallMarkers?(): string[];
  /** Upper bound on pages this ATS's application flow can legitimately span. The future engine's
   *  walk will be bounded by min(this, its own hard cap) so a redirect loop can never walk
   *  forever. */
  maxPages?(): number;

  // --- PHASE 9C — optional authentication contract ------------------------------------------------
  // Describes HOW this ATS's login/account UI works. It decides NOTHING about whether an account
  // may be created, whether a password is acceptable, or whether a consent checkbox is safe — those
  // are universal `ensureAuthenticated` decisions (see `../auth.ts` and `../engine/auth.ts`), made
  // identically for every ATS. Omitted entirely, exactly like every other Phase 9 optional member,
  // Greenhouse and Lever are unaffected: `resolveMultiPageConfig`'s login-wall handling already
  // treats an adapter with no `auth` as having nothing more automatable, and continues to pause with
  // the existing generic ACCOUNT_REQUIRED behavior.
  auth?(): AdapterAuthConfig;

  /**
   * PHASE 9E — how this ATS renders the options of a finite picker, when it is not the
   * `[role="option"]` convention the engine assumes by default.
   *
   * Observed on Workday: its pickers render options as `[data-automation-id="menuItem"]` and expose
   * no `aria-controls`, so the engine could neither find them nor scope them. Declaring the
   * selector is a UI fact, not a policy: the engine still decides what may be filled, and still
   * refuses to present options it cannot attribute to the control it opened.
   */
  pickerOptionSelector?(): string;

  // --- PHASE 9E.2 — optional application-ENTRY contract ------------------------------------------
  // Describes how to get from a saved apply_url that is NOT the form (a job posting, a career page)
  // to the form itself — or to the auth wall in front of it. Declared as EXACT observed selectors
  // with the text each control was observed carrying; the engine never text-searches for an entry
  // control, and refuses to click one whose text has since drifted.
  //
  // Omitted entirely (Greenhouse, Lever) the entry stage does nothing at all and the run behaves
  // byte-identically to before this contract existed — their apply_url IS the form.
  //
  // This describes NAVIGATION ONLY. It cannot express an answer, a consent decision, or permission
  // to submit: entry runs before a single field is filled, so there is nothing to submit when it
  // runs, and the executor enforces that ordering.
  entrySequence?(): ApplicationEntryStep[];
  /** Upper bound on entry steps. Bounded by the engine's own ENTRY_HARD_CAP; an adapter may only
   *  lower it. */
  entryMaxSteps?(): number;
}

/** Detected blocking conditions. Each maps to a run status that stops and asks the user. */
export type BlockingCondition = "captcha" | "mfa" | "email_verification" | "account_required" | "unknown_question";
