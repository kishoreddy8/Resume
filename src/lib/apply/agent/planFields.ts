import type { DiscoveredField, FieldPlan, AdapterContext, HumanQuestion, RunApprovedAnswer } from "./types";
import { matchQuestion } from "../questionMatching";
import { resolveAnswer, mayFill, type StoredAnswer } from "../resolveAnswer";
import { locationsCompatible } from "./locationNormalizer";
import { derivePhoneCountryCode } from "./phoneCountryNormalizer";
import type { QuestionType } from "../questionTypes";

/**
 * Deciding what the agent may type, field by field.
 *
 * THIS IS WHERE EVERY SAFETY RULE LIVES, and it is a pure function so all of them are testable
 * without a browser or a website. An adapter contributes selectors and page knowledge; it never
 * decides whether something may be filled.
 *
 * The default is to ASK. A field only gets a value when its provenance is one of the recognised
 * sources and the answer policy permits it. Everything else stops and asks the user, which is the
 * correct outcome for a real application sent under their name.
 */

export interface PlanInputs {
  fields: DiscoveredField[];
  context: AdapterContext;
  /** Wordings already seen, for the exact-match step. */
  knownVariants: Map<string, { canonicalKey: string; type: QuestionType }>;
  /** Stored answers by canonical key, for this candidate. */
  storedAnswers: Map<string, StoredAnswer>;
  /**
   * Candidate-approved answers scoped strictly to this ApplicationRun.
   * Keyed by questionId, selector, id, or label.
   */
  runAnswers?: Record<string, RunApprovedAnswer> | Map<string, RunApprovedAnswer>;
  /**
   * The adapter's canonicalKey -> selector map.
   *
   * Not an optimisation. Lever's core fields carry no label, aria-label or caption anywhere — they
   * are identified solely by their `name` attribute — so without these hints a real Lever form
   * would block on its own name and email fields. Verified against a live posting.
   */
  selectorHints?: Record<string, string>;
}

/**
 * Contact facts that come straight from the candidate's own verified details.
 *
 * These are the only values filled without consulting the vault, because they ARE the profile —
 * the same values the resume header carries, already validated by the contact resolver.
 */
function contactValueFor(canonicalKey: string, ctx: AdapterContext): string | null {
  switch (canonicalKey) {
    case "full_name":
      return ctx.contact.name || null;
    case "first_name":
      return ctx.contact.name.split(/\s+/)[0] || null;
    case "last_name": {
      const parts = ctx.contact.name.split(/\s+/);
      return parts.length > 1 ? parts.slice(1).join(" ") : null;
    }
    case "email":
      return ctx.contact.email || null;
    case "phone":
      return ctx.contact.phone || null;
    case "location_current":
      return ctx.contact.location || null;
    case "location_city":
      // The verified contact record stores one free-text location string ("Dallas, TX", "Remote,
      // US") — never a separate city field. This reads the part before the first comma from that
      // SAME already-verified value; it is not a new schema and not an inference, just the city
      // portion of data the candidate already confirmed.
      return ctx.contact.location.split(",")[0]?.trim() || null;
    case "country":
      // No verified country field exists anywhere in the candidate/contact schema, and one is
      // deliberately not invented here — a "Country" question falls through to the Answer Vault
      // below like any other question with no profile source, so it is asked once and then reused,
      // never guessed or derived from the job/employer.
      return null;
    case "linkedin_url":
      return ctx.contact.linkedin ?? null;
    case "github_url":
      return ctx.contact.github ?? null;
    default:
      return null;
  }
}

/**
 * PHASE 9D — single flat-field employment/education questions ("Current Employer", "Current Job
 * Title", "Field of Study", "School Name"), answered from the candidate's MOST RECENT record when
 * one has been supplied (`AdapterContext.employment`/`.education` are chronological, newest first —
 * see their own doc comments in types.ts).
 *
 * DELIBERATELY NARROW. A multi-entry, repeatable employment/education SECTION (Workday's own
 * per-entry sub-form, with its own "add another employer" control) is adapter-specific UI structure
 * this generic layer does not attempt to solve — that requires an observed real form, exactly like
 * any other adapter fact, and is out of scope here. Absent employment/education data, or a
 * canonical key not listed below, falls through to the vault like any other question — asked once,
 * never guessed. A value that doesn't exactly match a select/radio's current options is still
 * caught by the existing exact-option guard at the end of `planFields`, so a stored degree string
 * ("B.S.") that doesn't match a dropdown's option text ("Bachelor's Degree") becomes a question,
 * never a silently wrong answer.
 */
function employmentValueFor(canonicalKey: string, ctx: AdapterContext): string | null {
  const current = ctx.employment?.[0];
  if (!current) return null;
  switch (canonicalKey) {
    case "current_employer":
      return current.employer || null;
    case "current_job_title":
      return current.title || null;
    default:
      return null;
  }
}

function educationValueFor(canonicalKey: string, ctx: AdapterContext): string | null {
  const latest = ctx.education?.[0];
  if (!latest) return null;
  switch (canonicalKey) {
    case "field_of_study":
      return latest.field || null;
    case "institution_name":
      return latest.institution || null;
    case "highest_education":
      return latest.level || null;
    default:
      return null;
  }
}

/**
 * Resolve a field to a canonical question via the adapter's hints. Naming only, never values.
 *
 * Matches on the selector OR the control's own id/name, because the two can legitimately disagree:
 * selectorFor prefers #id when one exists, while an adapter may know the field by its name. Lever's
 * location input is exactly that — `name="location"` but `id="location-input"` — and comparing only
 * the rendered selector left it unidentified on a real form.
 */
function hintedKeyFor(
  field: { selector: string; id: string | null; name: string | null },
  hints: Record<string, string> | undefined,
  allFields?: DiscoveredField[]
): { canonicalKey: string; type: QuestionType } | null {
  if (!hints) return null;
  for (const [canonicalKey, hint] of Object.entries(hints)) {
    const type = HINT_TYPES[canonicalKey];
    if (!type) continue;

    const matchesHint =
      hint === field.selector ||
      (field.name && hint === `[name="${field.name}"]`) ||
      (hint.startsWith("#") && field.id === hint.slice(1));

    if (matchesHint) {
      // Special guard for phone_country_code: on Greenhouse, #country is the phone dialing prefix
      // only when accompanied by a phone input on the form. Outside a phone context (e.g. a generic
      // country combobox), #country remains the generic residence country.
      if (canonicalKey === "phone_country_code" && allFields) {
        const hasPhoneField = allFields.some(
          (f) => f.selector === "#phone" || f.id === "phone" || f.kind === "tel" || f.name === "phone"
        );
        if (!hasPhoneField) continue;
      }
      return { canonicalKey, type };
    }
  }
  return null;
}

/** The question type each hintable field represents. Only well-known factual fields appear here. */
const HINT_TYPES: Record<string, QuestionType> = {
  full_name: "identity",
  first_name: "identity",
  last_name: "identity",
  email: "contact",
  phone: "contact",
  phone_country_code: "contact",
  location_current: "contact",
  linkedin_url: "contact",
  github_url: "contact",
  portfolio_url: "contact",
};

/**
 * Look up a candidate-approved answer scoped strictly to this application run.
 *
 * Matching hierarchy:
 * 1. field.id / #id
 * 2. field.name / [name="..."]
 * 3. field.selector
 * 4. field.label
 */
function findRunApprovedAnswer(
  field: DiscoveredField,
  runAnswers?: Record<string, RunApprovedAnswer> | Map<string, RunApprovedAnswer>
): RunApprovedAnswer | null {
  if (!runAnswers) return null;

  const getAnswer = (key: string): RunApprovedAnswer | undefined => {
    if (runAnswers instanceof Map) {
      return runAnswers.get(key);
    }
    return runAnswers[key];
  };

  if (field.id) {
    const ans = getAnswer(field.id) ?? getAnswer(`#${field.id}`);
    if (ans) return ans;
  }
  if (field.name) {
    const ans = getAnswer(field.name) ?? getAnswer(`[name="${field.name}"]`);
    if (ans) return ans;
  }
  if (field.selector) {
    const ans = getAnswer(field.selector);
    if (ans) return ans;
  }
  if (field.label) {
    const ans = getAnswer(field.label);
    if (ans) return ans;
  }

  return null;
}

export function planFields(input: PlanInputs): FieldPlan[] {
  const plans: FieldPlan[] = [];

  for (const field of input.fields) {
    // --- documents ---------------------------------------------------------------------------
    if (field.kind === "file") {
      const id = `${field.id ?? ""} ${field.name ?? ""} ${field.label ?? ""}`.toLowerCase();
      if (id.includes("resume") || id.includes("cv")) {
        if (input.context.resumePath) {
          plans.push({ action: "upload", field, filePath: input.context.resumePath, source: "VALIDATED_CANDIDATE_PROFILE" });
        } else {
          /* No validated resume means no upload. The agent never reaches for an older file — a
           * resume that has not passed validation for THIS job is not a document to send. */
          plans.push({ action: "ask", field, question: field.label ?? "Resume", reason: "No validated resume is available for this job.", questionType: null });
        }
        continue;
      }
      if (id.includes("cover")) {
        if (input.context.coverLetterPath) {
          plans.push({ action: "upload", field, filePath: input.context.coverLetterPath, source: "VALIDATED_CANDIDATE_PROFILE" });
        } else {
          plans.push({ action: "skip", field, reason: "No cover letter was generated for this job." });
        }
        continue;
      }
      plans.push({ action: "ask", field, question: field.label ?? "File upload", reason: "Unrecognised file field.", questionType: null });
      continue;
    }

    /* An adapter hint identifies a field the ATS names consistently but does not label. It maps a
     * SELECTOR to a canonical key, so it can only ever name a field, never supply its value. */
    const hinted = hintedKeyFor(field, input.selectorHints, input.fields);

    // --- a field with neither a label nor a hint ------------------------------------------------
    if (!field.label && !hinted) {
      const runApproved = findRunApprovedAnswer(field, input.runAnswers);
      if (runApproved) {
        if (field.options && field.options.length > 0 && !field.options.includes(runApproved.answer)) {
          plans.push({
            action: "ask",
            field,
            question: field.id ?? field.selector,
            reason: "Saved answer is no longer one of the options offered by this form.",
            questionType: runApproved.questionType ?? null,
          });
          continue;
        }
        plans.push({
          action: "fill",
          field,
          value: runApproved.answer,
          source: "USER_INTERVENTION",
          canonicalKey: runApproved.canonicalKey ?? null,
        });
        continue;
      }
      plans.push({ action: "ask", field, question: field.id ?? field.selector, reason: "This field has no label to identify it.", questionType: null });
      continue;
    }

    const match = hinted ?? matchQuestion(field.label!, input.knownVariants);
    if (!match) {
      const runApproved = findRunApprovedAnswer(field, input.runAnswers);
      if (runApproved) {
        if (field.options && field.options.length > 0 && !field.options.includes(runApproved.answer)) {
          plans.push({
            action: "ask",
            field,
            question: field.label!,
            reason: "Saved answer is no longer one of the options offered by this form.",
            questionType: runApproved.questionType ?? null,
          });
          continue;
        }
        plans.push({
          action: "fill",
          field,
          value: runApproved.answer,
          source: "USER_INTERVENTION",
          canonicalKey: runApproved.canonicalKey ?? null,
        });
        continue;
      }

      plans.push({ action: "ask", field, question: field.label!, reason: "Career-Ops has no answer for this question.", questionType: null });
      continue;
    }

    // --- location_city: negotiate vault canonical form against the verified profile city --------
    // `contactValueFor` returns the bare city ("Dallas" from "Dallas, TX"), which cannot
    // exactly match Greenhouse's canonical option ("Dallas, Texas, United States").
    // We therefore check the vault first: if it holds a compatible canonical form, use it;
    // if it conflicts, ask; if absent, fall back to the bare city with locationContext so the
    // executor can normalise at click time.
    if (match.canonicalKey === "location_city") {
      const profileLocation = input.context.contact.location;
      const stored = input.storedAnswers.get("location_city");
      if (stored) {
        const vaultRes = resolveAnswer(match.type, stored);
        if (vaultRes.action === "fill" && mayFill(vaultRes.source)) {
          if (locationsCompatible(profileLocation, vaultRes.value)) {
            plans.push({
              action: "fill",
              field,
              value: vaultRes.value,
              source: vaultRes.source,
              canonicalKey: "location_city",
              locationContext: profileLocation,
            });
          } else {
            plans.push({
              action: "ask",
              field,
              question: field.label ?? "Location (City)",
              reason: "The saved city doesn't match your verified profile location.",
              questionType: match.type,
            });
          }
          continue;
        }
      }
      const profileCity = contactValueFor("location_city", input.context);
      if (profileCity) {
        plans.push({
          action: "fill",
          field,
          value: profileCity,
          source: "PROFILE",
          canonicalKey: "location_city",
          locationContext: profileLocation,
        });
        continue;
      }
      plans.push({
        action: "ask",
        field,
        question: field.label ?? "Location (City)",
        reason: "No saved answer for this question.",
        questionType: match.type,
      });
      continue;
    }

    // --- phone_country_code: negotiate vault or derive from verified contact phone + location --
    if (match.canonicalKey === "phone_country_code") {
      const stored = input.storedAnswers.get("phone_country_code");
      if (stored) {
        const vaultRes = resolveAnswer(match.type, stored);
        if (vaultRes.action === "fill" && mayFill(vaultRes.source)) {
          plans.push({
            action: "fill",
            field,
            value: vaultRes.value,
            source: vaultRes.source,
            canonicalKey: "phone_country_code",
            phoneCountryContext: vaultRes.value,
          });
          continue;
        }
      }
      const derived = derivePhoneCountryCode(input.context.contact.phone, input.context.contact.location);
      if (derived) {
        plans.push({
          action: "fill",
          field,
          value: derived.dialCode,
          source: "PROFILE",
          canonicalKey: "phone_country_code",
          phoneCountryContext: derived.countryName,
        });
        continue;
      }
      plans.push({
        action: "ask",
        field,
        question: field.label ?? "Phone country code",
        reason: "Could not safely determine phone country dial code from verified contact details.",
        questionType: match.type,
      });
      continue;
    }

    // --- profile facts -------------------------------------------------------------------------
    const fromProfile =
      contactValueFor(match.canonicalKey, input.context) ??
      employmentValueFor(match.canonicalKey, input.context) ??
      educationValueFor(match.canonicalKey, input.context);
    if (fromProfile) {
      plans.push({ action: "fill", field, value: fromProfile, source: "PROFILE", canonicalKey: match.canonicalKey });
      continue;
    }

    // --- the vault -----------------------------------------------------------------------------
    const resolution = resolveAnswer(match.type, input.storedAnswers.get(match.canonicalKey));
    if (resolution.action === "fill" && mayFill(resolution.source)) {
      plans.push({ action: "fill", field, value: resolution.value, source: resolution.source, canonicalKey: match.canonicalKey });
      continue;
    }

    // --- candidate-approved answer for this run ------------------------------------------------
    const runApproved = findRunApprovedAnswer(field, input.runAnswers);
    if (runApproved) {
      if (field.options && field.options.length > 0 && !field.options.includes(runApproved.answer)) {
        plans.push({
          action: "ask",
          field,
          question: field.label ?? match.canonicalKey,
          reason: "Saved answer is no longer one of the options offered by this form.",
          questionType: match.type,
        });
        continue;
      }
      plans.push({
        action: "fill",
        field,
        value: runApproved.answer,
        source: "USER_INTERVENTION",
        canonicalKey: match.canonicalKey,
      });
      continue;
    }

    plans.push({
      action: "ask",
      field,
      question: field.label ?? match.canonicalKey,
      /* A "fill" that reached here failed mayFill — its provenance is not recognised, which is a
       * reason to stop rather than a value to salvage. */
      reason: resolution.action === "fill" ? "This answer's source is not one Career-Ops can fill from." : resolution.reason,
      questionType: match.type,
    });
  }

  /* PHASE 9B — a select or radio may only be filled with a value the form actually offers.
   * Exact-match discipline, same as comboboxes (see comboboxSelection.ts): when the discovered
   * options are known and the planned value is not literally one of them, the safe outcome is to
   * ask — never the first option, never a close match. Radio groups usually surface without a
   * discovered options list; those are held to the same exact-match rule at execution time. */
  return plans.map((plan) => {
    if (plan.action !== "fill") return plan;
    if (plan.field.kind !== "select" && plan.field.kind !== "radio") return plan;
    const options = plan.field.options;
    if (!options || options.length === 0 || options.includes(plan.value)) return plan;
    return {
      action: "ask" as const,
      field: plan.field,
      question: plan.field.label ?? plan.canonicalKey ?? plan.field.selector,
      reason: `"${plan.value}" is not one of the options this form offers.`,
      questionType: null,
    };
  });
}

/** The first thing the run must stop for, or null when every field is settled. */
export function firstBlocker(plans: FieldPlan[]): Extract<FieldPlan, { action: "ask" }> | null {
  /* Required fields first: an optional unanswered question should not hold up an application the
   * user could otherwise review. */
  const asks = plans.filter((p): p is Extract<FieldPlan, { action: "ask" }> => p.action === "ask");
  return asks.find((p) => p.field.required) ?? asks[0] ?? null;
}

/** Required fields with no value planned — what the review screen must warn about. */
export function unresolvedRequired(plans: FieldPlan[]): FieldPlan[] {
  return plans.filter((p) => p.field.required && (p.action === "ask" || p.action === "skip"));
}

/**
 * Collect every required unanswered field into one batch for the user to answer at once.
 *
 * Replaces the old single-pause (firstBlocker) with a comprehensive batch so the user can supply
 * all missing answers in one UI interaction rather than one per execution cycle.
 */
export function collectHumanQuestions(
  plans: FieldPlan[],
  knownVariants: Map<string, { canonicalKey: string; type: QuestionType }>
): HumanQuestion[] {
  return plans
    .filter((p): p is Extract<FieldPlan, { action: "ask" }> => p.action === "ask" && p.field.required)
    .map((p) => {
      const match = matchQuestion(p.question, knownVariants);
      return {
        id: p.field.id ?? p.field.name ?? p.field.selector,
        selector: p.field.selector,
        label: p.question,
        canonicalKey: match?.canonicalKey ?? null,
        questionType: p.questionType ?? match?.type ?? null,
        required: p.field.required,
        kind: p.field.kind,
        options: p.field.options && p.field.options.length > 0 ? p.field.options : null,
        reason: p.reason,
      };
    });
}
