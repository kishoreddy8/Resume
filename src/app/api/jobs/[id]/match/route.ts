import { NextRequest, NextResponse } from "next/server";
import { getAppSettings } from "@/db/queries/settings";
import { getJob } from "@/db/queries/jobs";
import { getJobCertifications, getJobSkills } from "@/db/queries/jobIntel";
import { getJobMatchResult, getLatestJobMatchResult, insertJobMatchResult } from "@/db/queries/jobMatches";
import { evaluateJobMatch, type EvaluateJobMatchInput } from "@/lib/match/evaluateJobMatch";
import type { DescriptionSections, JobWithCompany } from "@/types";

/**
 * Single-job Phase 2 matching. Deterministic only — zero AI calls, zero cost, cheap enough to run
 * synchronously (unlike "Enrich with AI", GET is safe to call on page mount). Never mutates any
 * `jobs.*` column — writes only into job_match_results, the same "AI/Phase-2-output namespaced away
 * from authoritative data" pattern ai-enrich already established for the AI layer.
 */

function parseDescriptionSections(json: string | null): DescriptionSections | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? (parsed as DescriptionSections) : null;
  } catch {
    return null;
  }
}

function buildInput(job: JobWithCompany): EvaluateJobMatchInput {
  return {
    jobId: job.id,
    dedupeKey: job.dedupe_key,
    jobTitle: job.title,
    descriptionText: job.description_text,
    descriptionSections: parseDescriptionSections(job.description_sections),
    skills: getJobSkills(job.id),
    certifications: getJobCertifications(job.id),
    education: {
      level: job.education_level,
      field: job.education_field,
      requirement: job.education_requirement,
      equivalentExperienceAllowed: job.education_equivalent_experience_allowed === 1,
      evidence: job.education_evidence,
    },
    sponsorshipPolarity: job.sponsorship_polarity,
    companyH1bConfidence: job.company_h1b_confidence,
    clearanceRequired: job.clearance_required,
    clearanceLevel: job.clearance_level,
    citizenshipRequired: job.citizenship_required,
    workAuthorizationRequired: job.work_authorization_required,
    jobSeniority: job.seniority ?? "Unknown",
    experienceMinYears: job.experience_min_years,
  };
}

function parseJobId(id: string): number | null {
  const jobId = Number(id);
  return Number.isInteger(jobId) ? jobId : null;
}

/** Evaluate (or return the existing cached result for) this job. Always computes fresh and lets
 *  insertJobMatchResult's own exact-key lookup decide cache-hit vs. fresh-insert — cheap enough
 *  (pure, deterministic, no I/O beyond one candidate-profile file read) that a redundant compute on
 *  a cache hit is not worth optimizing away with a separate pre-check. */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const jobId = parseJobId(id);
  if (jobId === null) return NextResponse.json({ error: "Invalid job id" }, { status: 400 });

  const job = getJob(jobId);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const settings = getAppSettings();
  const result = evaluateJobMatch(buildInput(job), settings.candidate);

  if (result.status === "unavailable") {
    return NextResponse.json({ status: "unavailable", reason: result.reason });
  }

  // Check hit/miss BEFORE inserting — insertJobMatchResult itself is hit-or-insert, so this is the
  // only reliable way to report `cached` accurately (comparing timestamps after the fact is not:
  // SQLite's datetime('now') and the JS computedAt ISO string can coincidentally look "different"
  // even on a genuine fresh insert).
  const existing = getJobMatchResult({
    dedupeKey: result.data.dedupeKey,
    matchEngineVersion: result.data.matchEngineVersion,
    matchKnowledgeHash: result.data.matchKnowledgeHash,
    candidateProfileHash: result.data.candidateProfileHash,
    candidateSettingsHash: result.data.candidateSettingsHash,
    jdContentHash: result.data.jdContentHash,
  });
  insertJobMatchResult(result.data);
  return NextResponse.json({ status: "ok", cached: Boolean(existing), result: result.data });
}

/** Latest cached result, if any — cheap/deterministic, safe to fetch on page mount (unlike the AI
 *  card's strictly on-demand pattern). Does NOT trigger a fresh evaluation; use POST for that. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const jobId = parseJobId(id);
  if (jobId === null) return NextResponse.json({ error: "Invalid job id" }, { status: 400 });

  const job = getJob(jobId);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const row = getLatestJobMatchResult(job.dedupe_key);
  if (!row) return NextResponse.json({ status: "none" });

  return NextResponse.json({
    status: "ok",
    result: {
      jobId: row.job_id,
      dedupeKey: row.dedupe_key,
      matchEngineVersion: row.match_engine_version,
      computedAt: row.created_at,
      eligibility: { status: row.eligibility_status, reasons: JSON.parse(row.eligibility_reasons) },
      dimensionScores: JSON.parse(row.dimension_scores),
      overallScore: row.overall_score,
      requirementCoverage: row.requirement_coverage,
      employerEvidencedShare: row.employer_evidenced_share,
      insufficientJdSignal: Boolean(row.insufficient_jd_signal),
      ...JSON.parse(row.requirement_breakdown),
      recommendedTrack: row.recommended_track,
      decision: row.decision,
      blockingReasons: JSON.parse(row.blocking_reasons),
    },
  });
}
