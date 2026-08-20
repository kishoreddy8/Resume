import type { DiscoveredField, FieldPlan, AdapterContext } from "./types";
import { matchQuestion } from "../questionMatching";
import { resolveAnswer, mayFill, type StoredAnswer } from "../resolveAnswer";
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
    case "linkedin_url":
      return ctx.contact.linkedin ?? null;
    case "github_url":
      return ctx.contact.github ?? null;
    default:
      return null;
  }
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

    // --- a field with no question attached ------------------------------------------------------
    if (!field.label) {
      plans.push({ action: "ask", field, question: field.id ?? field.selector, reason: "This field has no label to identify it.", questionType: null });
      continue;
    }

    const match = matchQuestion(field.label, input.knownVariants);
    if (!match) {
      plans.push({ action: "ask", field, question: field.label, reason: "Career-Ops has no answer for this question.", questionType: null });
      continue;
    }

    // --- profile facts -------------------------------------------------------------------------
    const fromProfile = contactValueFor(match.canonicalKey, input.context);
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

    plans.push({
      action: "ask",
      field,
      question: field.label,
      /* A "fill" that reached here failed mayFill — its provenance is not recognised, which is a
       * reason to stop rather than a value to salvage. */
      reason: resolution.action === "fill" ? "This answer's source is not one Career-Ops can fill from." : resolution.reason,
      questionType: match.type,
    });
  }

  return plans;
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
