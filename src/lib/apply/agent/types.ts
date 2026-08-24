import type { SourceType } from "@/types";
import type { AnswerSource, QuestionType } from "../questionTypes";

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
  kind: "text" | "email" | "tel" | "textarea" | "select" | "combobox" | "checkbox" | "radio" | "file" | "unknown";
  /** The visible label, or the accessible name. This is what gets matched against questions. */
  label: string | null;
  id: string | null;
  name: string | null;
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

export interface AdapterContext {
  candidateId: number;
  /** Verbatim contact facts. Never derived, never guessed — see resolveCandidateContact. */
  contact: { name: string; email: string; phone: string; location: string; linkedin?: string; github?: string };
  resumePath: string | null;
  coverLetterPath: string | null;
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
}

/** Detected blocking conditions. Each maps to a run status that stops and asks the user. */
export type BlockingCondition = "captcha" | "mfa" | "email_verification" | "account_required" | "unknown_question";
