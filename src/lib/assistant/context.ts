import { getJob } from "@/db/queries/jobs";
import { getCompany } from "@/db/queries/companies";
import { deserializeJobMatchResult, getLatestJobMatchResult } from "@/db/queries/jobMatches";
import { loadCandidateProfile } from "@/lib/match/candidateProfile";
import { buildTailoringPlan } from "@/lib/tailoringIntelligence/plan";

/**
 * The evidence pack an assistant answer must be built from.
 *
 * WHY GROUNDING IS THE WHOLE DESIGN. Every question this assistant exists to answer — why is this
 * job under review, where does my PySpark evidence come from, why is a role excluded from
 * cross-client use — is a question about THIS installation's state. A model answering from general
 * knowledge would produce something fluent and unrelated to the user's actual data, which is worse
 * than no answer because it looks like one. So the model is handed facts and asked to explain them,
 * never asked to supply them.
 *
 * READ-ONLY BY CONSTRUCTION. Everything here comes from existing readers. Nothing writes, nothing
 * evaluates, nothing re-runs the match engine, and no candidate evidence is derived — the plan is
 * assembled from the match result already persisted.
 */

export interface AssistantContext {
  /** Human-readable facts, already resolved. The prompt embeds these verbatim. */
  facts: string[];
  /** Short description of what the pack covers, for the UI. */
  scope: string;
}

function line(label: string, value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  return `${label}: ${value}`;
}

/**
 * Build the pack for one job, for one candidate.
 *
 * Returns null when the job has not been evaluated: an assistant asked to explain a decision that
 * was never made would have to invent one, and declining is the honest outcome.
 */
export function buildJobContext(candidateId: number, jobId: number): AssistantContext | null {
  const job = getJob(jobId);
  if (!job) return null;

  const row = getLatestJobMatchResult(candidateId, job.dedupe_key);
  if (!row) return null;

  const result = deserializeJobMatchResult(row);
  const loaded = loadCandidateProfile(candidateId);
  const profile = loaded.status === "ok" ? loaded.profile : null;
  const plan = buildTailoringPlan(result, profile);

  const company = job.company_id ? getCompany(job.company_id)?.name ?? null : null;

  const facts: (string | null)[] = [
    line("Job title", job.title),
    line("Company", company),
    line("Engine decision", result.decision),
    line("Overall score", result.insufficientJdSignal ? "not trusted — the posting carried too little detail" : result.overallScore),
    line("Eligibility", `${result.eligibility.status}${result.eligibility.reasons.length ? ` (${result.eligibility.reasons.join("; ")})` : ""}`),
    line("Sponsorship signal", `${result.eligibility.sponsorship.signal} — ${result.eligibility.sponsorship.note}`),
    line("Candidate profile status", loaded.status),
  ];

  if (plan.requirements.length > 0) {
    facts.push("", "REQUIREMENTS AND THE EVIDENCE BEHIND EACH:");
    for (const r of plan.requirements.slice(0, 40)) {
      const sources = r.sources.length > 0 ? ` [sources: ${r.sources.join("; ")}]` : "";
      facts.push(`- ${r.label} (${r.requirementLevel}) — ${r.state}${sources}`);
    }
  }

  if (plan.employerEmphasis.length > 0) {
    facts.push("", "PER-ROLE EVIDENCE FOR THIS JOB:");
    for (const e of plan.employerEmphasis) {
      const parts = [
        `written here: ${e.alreadyWritten.length ? e.alreadyWritten.join(", ") : "none of this job's requirements"}`,
        `available via the Master Skills Inventory: ${e.viaMsi.length ? e.viaMsi.join(", ") : "none"}`,
      ];
      if (!e.inventoryReachesRole) {
        parts.push(
          "the Skills Inventory does NOT reach this role — nothing in its own recorded work resolves to a known technology, so it is outside the candidate's technical domain"
        );
      }
      if (e.prohibitedHere.length > 0) {
        parts.push(`explicitly scoped to other clients: ${e.prohibitedHere.join(", ")}`);
      }
      facts.push(`- ${e.employer} (${e.title}): ${parts.join("; ")}`);
    }
  }

  if (plan.doNotClaim.length > 0) {
    facts.push("", `NO EVIDENCE ANYWHERE (must never be claimed): ${plan.doNotClaim.map((r) => r.label).join(", ")}`);
  }

  return {
    scope: `job ${jobId} for candidate ${candidateId}`,
    facts: facts.filter((f): f is string => f !== null),
  };
}

/**
 * The instruction wrapped around a pack.
 *
 * The rules exist because the failure mode here is not refusal but confident fluency: a model asked
 * about a candidate's experience will happily produce a plausible answer from nothing. Each rule
 * closes one route to that.
 */
export function buildAssistantPrompt(question: string, context: AssistantContext): string {
  return [
    "You are explaining the state of a job-search application called Career-Ops to its user.",
    "",
    "RULES — these outrank being helpful:",
    "1. Answer ONLY from the facts below. They are the complete record available to you.",
    "2. If the facts do not answer the question, say so plainly and stop. Do not reason from general",
    "   knowledge about the technologies or companies involved.",
    "3. Never state that the candidate used a technology at an employer unless the facts say so.",
    "   \"Available via the Master Skills Inventory\" means the candidate declared the skill, NOT that",
    "   they used it at that employer. Keep that distinction in every sentence.",
    "4. Never invent an employer, project, date, year, certification, score or requirement.",
    "5. Report the engine's decision as the engine's; do not agree, disagree, or re-decide.",
    "6. Be concise. A short accurate answer beats a long one.",
    "",
    `QUESTION: ${question}`,
    "",
    "FACTS:",
    ...context.facts,
  ].join("\n");
}
