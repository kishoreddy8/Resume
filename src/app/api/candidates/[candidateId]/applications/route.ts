import fs from "node:fs";
import { NextResponse, type NextRequest } from "next/server";
import { requireActiveCandidate } from "@/db/queries/candidates";
import { requireCandidateAccess } from "@/lib/auth/guard";
import { listAllCandidateJobStatesForCandidate, listCandidateJobStateHistory } from "@/db/queries/candidateJobState";
import { getJobByDedupeKey } from "@/db/queries/jobs";
import { getCompany } from "@/db/queries/companies";
import { generatedFilesDir } from "@/lib/generatedFiles";
import { deriveNextAction, type ApplicationRecord } from "@/lib/applications/nextAction";

/**
 * GET — every job this candidate has actually acted on, with its stage, documents and history.
 *
 * BOUNDED BY CONSTRUCTION. It reads candidate_job_state, which only gains a row when the user does
 * something to a job — sets a stage, pins it, approves tailoring, writes a note. A candidate with
 * 150,000 evaluated jobs still has a handful of rows here. That is the whole reason this route
 * exists rather than filtering the jobs list: the previous Pipeline page rendered a card per job
 * and collapsed under its own weight, and no cap or virtualisation fixes a query that was wrong to
 * ask in the first place.
 *
 * History is per-application and NOT loaded here. Fetching change logs for every row to render a
 * list would repeat that same mistake in miniature — pass ?dedupeKey= for one application's detail.
 *
 * Read-only. It writes nothing, changes no stage, and invents no event: every timeline entry comes
 * from candidate_job_state_history, and an application with no recorded history shows none.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ candidateId: string }> }) {
  const { candidateId: raw } = await ctx.params;
  const candidateId = Number(raw);
  if (!Number.isInteger(candidateId) || candidateId <= 0) {
    return NextResponse.json({ error: "Invalid candidate id" }, { status: 400 });
  }
  if (!requireActiveCandidate(candidateId)) {
    return NextResponse.json({ error: "Not an active candidate" }, { status: 404 });
  }
  const accessDenial = requireCandidateAccess(req, candidateId);
  if (accessDenial) return accessDenial;

  const detailKey = req.nextUrl.searchParams.get("dedupeKey");
  const states = listAllCandidateJobStatesForCandidate(candidateId);

  const applications: ApplicationRecord[] = [];
  for (const [dedupeKey, state] of Object.entries(states)) {
    const job = getJobByDedupeKey(dedupeKey);
    if (!job) continue; // The job row was archived away; its state is not an application any more.

    /* A directory read per application, over a list bounded to acted-on jobs. Counting files is the
     * only honest way to say whether documents exist — the workflow writes them to disk and no
     * table mirrors that. */
    /* One lookup per acted-on application. `jobs` stores company_id, and the name lives on the
     * company row — resolved here rather than joined, because this list is small by construction. */
    const companyName = job.company_id ? (getCompany(job.company_id)?.name ?? null) : null;

    let generatedFileCount = 0;
    try {
      const dir = generatedFilesDir(companyName ?? "", job.id);
      generatedFileCount = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => !f.startsWith(".")).length : 0;
    } catch {
      generatedFileCount = 0;
    }

    applications.push({
      dedupeKey,
      jobId: job.id,
      title: job.title,
      company: companyName,
      stage: state.pipeline_status,
      stageUpdatedAt: state.pipeline_updated_at ?? null,
      markedForTailoring: state.marked_for_tailoring === 1,
      pinned: state.pinned === 1,
      notInterested: state.not_interested === 1,
      notes: state.notes ?? null,
      generatedFileCount,
      nextAction: "",
    });
  }

  for (const app of applications) app.nextAction = deriveNextAction(app);

  /* Newest activity first, then title for a stable order. Never a computed "urgency". */
  applications.sort(
    (a, b) => (b.stageUpdatedAt ?? "").localeCompare(a.stageUpdatedAt ?? "") || a.title.localeCompare(b.title)
  );

  const counts: Record<string, number> = {};
  for (const app of applications) counts[app.stage] = (counts[app.stage] ?? 0) + 1;

  return NextResponse.json({
    candidateId,
    counts,
    applications,
    /* Only when one application was asked for. Recorded events only — nothing is synthesised to
     * fill a gap in a timeline. */
    history: detailKey ? listCandidateJobStateHistory(candidateId, detailKey) : null,
  });
}
