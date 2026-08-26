import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAiEnrichmentById } from "@/db/queries/aiEnrichments";
import { recordAiAuditEvent } from "@/db/queries/aiAudit";
import { getJob } from "@/db/queries/jobs";
import {
  filterSuggestions,
  jobDetailEnrichmentTask,
  type JobDetailEnrichmentInput,
  type JobDetailEnrichmentKnownFields,
  type JobDetailEnrichmentOutput,
} from "@/lib/ai/tasks/jobDetailEnrichment";
import { runAiTask } from "@/lib/ai/runAiTask";
import { requireCandidateAccess } from "@/lib/auth/guard";
import { requireActiveCandidate } from "@/db/queries/candidates";
import type { DescriptionSections, JobWithCompany } from "@/types";

/**
 * "Enrich with AI" — Job Detail. On-demand only: this route is never called by page load, by a
 * scan, or by any other Phase 1 code path — see src/app/jobs/[id]/AiInsightsCard.tsx, the only
 * caller, which fires strictly on a user click. Never mutates any `jobs.*` column — this route has
 * no write path into that table at all, only reads (getJob) plus writes into the AI-only tables via
 * runAiTask/recordAiAuditEvent.
 */

function parseDescriptionSectionsJson(json: string | null): DescriptionSections | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? (parsed as DescriptionSections) : null;
  } catch {
    return null;
  }
}

function buildKnownFields(job: JobWithCompany): JobDetailEnrichmentKnownFields {
  return {
    seniority: job.seniority ? { status: "known", value: job.seniority } : { status: "unknown" },
    employmentType: job.employment_type_normalized ? { status: "known", value: job.employment_type_normalized } : { status: "unknown" },
    workplaceType: job.workplace_type_normalized ? { status: "known", value: job.workplace_type_normalized } : { status: "unknown" },
    industryDomain: job.industry_domain ? { status: "known", value: job.industry_domain } : { status: "unknown" },
    compensation:
      job.salary_min !== null || job.salary_max !== null
        ? {
            status: "known",
            value: { min: job.salary_min, max: job.salary_max, currency: job.salary_currency, period: job.salary_period },
          }
        : { status: "unknown" },
  };
}

function buildInput(job: JobWithCompany): JobDetailEnrichmentInput {
  const rawSections = parseDescriptionSectionsJson(job.description_sections);
  return {
    title: job.title,
    fullDescriptionText: job.description_text ?? "",
    descriptionSections: rawSections
      ? {
          responsibilities: rawSections.responsibilities ?? null,
          requiredQualifications: rawSections.qualifications ?? null,
          preferredQualifications: rawSections.niceToHave ?? null,
          benefits: rawSections.benefits ?? null,
        }
      : null,
    knownFields: buildKnownFields(job),
  };
}

/**
 * ADMIN-SEC-1 — the highest-consequence of the three job routes: it is the only route in the app
 * that can spend real provider money. On an install where AI is enabled and a key is configured, an
 * unauthenticated caller could previously bill the operator in a loop, bounded only by the hardcoded
 * budget caps. It IS reached from the candidate product (AiInsightsCard on job detail), so the fix
 * is authentication rather than the operator boundary, which would remove the feature.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  /* ADMIN-SEC-1 — CANDIDATE_MUTATION. This writes to the shared `jobs` corpus, so it is not
   * candidate-OWNED data, but it is reached from the candidate product and must not require the
   * operator boundary: doing so would break the feature for every non-owner profile and for any
   * install without a PIN. The boundary this closes is the real one — it was callable by anyone who
   * could reach the port. candidateId is an explicit query parameter, never inferred, so the request
   * names the profile whose unlocked session is authorising the write. */
  const candidateId = Number(req.nextUrl.searchParams.get("candidateId"));
  if (!Number.isInteger(candidateId) || candidateId <= 0) {
    return NextResponse.json({ error: "candidateId is required" }, { status: 400 });
  }
  if (!requireActiveCandidate(candidateId)) {
    return NextResponse.json({ error: "Not an active candidate" }, { status: 404 });
  }
  const accessDenial = requireCandidateAccess(req, candidateId);
  if (accessDenial) return accessDenial;

  const { id } = await params;
  const jobId = Number(id);
  if (!Number.isInteger(jobId)) {
    return NextResponse.json({ error: "Invalid job id" }, { status: 400 });
  }

  const job = getJob(jobId);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  if (!job.description_text) {
    return NextResponse.json({ error: "This job has no stored description to enrich" }, { status: 400 });
  }

  const input = buildInput(job);
  const result = await runAiTask<JobDetailEnrichmentOutput>(
    jobDetailEnrichmentTask.id,
    { type: "job", key: job.dedupe_key, id: job.id },
    input
  );

  if (result.status === "unavailable") {
    return NextResponse.json({ status: "unavailable", reason: result.reason });
  }

  // Read-time filter (see jobDetailEnrichment.ts's own doc comment): applied identically whether
  // this was a fresh generation or a cache hit, against the job's REAL, authoritative, untruncated
  // description_text — never the bounded text actually sent to the provider.
  const suggestions = filterSuggestions(result.data.suggestions, {
    fullDescriptionText: job.description_text,
    knownFields: input.knownFields,
  });

  return NextResponse.json({
    status: "ok",
    cached: result.cached,
    enrichmentId: result.enrichmentId,
    summary: result.data.summary,
    suggestions,
  });
}

const PATCH_SCHEMA = z
  .object({
    enrichmentId: z.number().int().positive(),
    event: z.enum(["accepted", "rejected"]),
    field: z.enum(["seniority", "employmentType", "workplaceType", "industryDomain", "compensation"]),
  })
  .strict();

/** Per-field accept/reject. `field` is stored in ai_audit_log.note (no schema change — see the AI
 *  Architecture plan's review-granularity design) so a future read can distinguish "accepted
 *  industry / rejected seniority / unreviewed workplace" for the same enrichment row. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  /* ADMIN-SEC-1 — CANDIDATE_MUTATION. This writes to the shared `jobs` corpus, so it is not
   * candidate-OWNED data, but it is reached from the candidate product and must not require the
   * operator boundary: doing so would break the feature for every non-owner profile and for any
   * install without a PIN. The boundary this closes is the real one — it was callable by anyone who
   * could reach the port. candidateId is an explicit query parameter, never inferred, so the request
   * names the profile whose unlocked session is authorising the write. */
  const candidateId = Number(req.nextUrl.searchParams.get("candidateId"));
  if (!Number.isInteger(candidateId) || candidateId <= 0) {
    return NextResponse.json({ error: "candidateId is required" }, { status: 400 });
  }
  if (!requireActiveCandidate(candidateId)) {
    return NextResponse.json({ error: "Not an active candidate" }, { status: 404 });
  }
  const accessDenial = requireCandidateAccess(req, candidateId);
  if (accessDenial) return accessDenial;

  const { id } = await params;
  const jobId = Number(id);
  if (!Number.isInteger(jobId)) {
    return NextResponse.json({ error: "Invalid job id" }, { status: 400 });
  }

  const job = getJob(jobId);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const body = await req.json().catch(() => null);
  const parsed = PATCH_SCHEMA.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const enrichment = getAiEnrichmentById(parsed.data.enrichmentId);
  if (!enrichment) {
    return NextResponse.json({ error: "Enrichment not found" }, { status: 404 });
  }
  // Ownership check (see the AI Architecture plan's enrichment-id/audit-correlation design): the
  // client sends back an id it captured at view time, never a server-side "latest for this job"
  // lookup — but that id must still actually belong to THIS job before being acted on.
  if (enrichment.entity_type !== "job" || enrichment.entity_key !== job.dedupe_key) {
    return NextResponse.json({ error: "This enrichment does not belong to the specified job" }, { status: 400 });
  }

  recordAiAuditEvent(enrichment.id, parsed.data.event, parsed.data.field);

  return NextResponse.json({ ok: true });
}
