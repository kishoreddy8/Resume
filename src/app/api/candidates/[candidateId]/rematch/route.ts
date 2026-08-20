import { NextRequest, NextResponse } from "next/server";
import { requireCandidateAccess } from "@/lib/auth/guard";
import { z } from "zod";
import { requireActiveCandidate } from "@/db/queries/candidates";
import {
  MAX_REMATCH_PAGE_SIZE,
  rematchCandidateJobsPage,
  type RematchCandidatePageResult,
} from "@/lib/match/rematchCandidate";

/**
 * Phase 4 Stage 5 — candidate-scoped bounded rematch. ONE page per request, never the full walk:
 * a candidate's actionable set is ~19.4k jobs and Phase 2 costs ~20 ms/job on a cache miss, so a
 * whole-set rematch inside a request would block the app for minutes (see rematchCandidate.ts).
 * The client owns the cursor loop; for an unattended full pass use `npm run rematch-candidate`,
 * which drives the same service outside any request lifetime.
 *
 * Candidate isolation matches every other candidate-scoped route here: the id comes from the path,
 * is validated with requireActiveCandidate, and is the only candidate the service is ever given —
 * there is no body field that could redirect the work to, or expose, another candidate.
 */

const bodySchema = z
  .object({
    /** Keyset cursor from a previous page's nextCursor. 0/omitted starts from the beginning. */
    afterJobId: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(MAX_REMATCH_PAGE_SIZE).optional(),
  })
  .strict();

export type RematchApiResponse = RematchCandidatePageResult;

export async function POST(req: NextRequest, { params }: { params: Promise<{ candidateId: string }> }) {
  const { candidateId: candidateIdParam } = await params;
  const candidateId = Number(candidateIdParam);
  if (!Number.isInteger(candidateId)) return NextResponse.json({ error: "Invalid candidateId" }, { status: 400 });
  if (!requireActiveCandidate(candidateId)) return NextResponse.json({ error: "Not an active candidate" }, { status: 404 });
  const accessDenial = requireCandidateAccess(req, candidateId);
  if (accessDenial) return accessDenial;

  // An absent/empty body is a valid "first page, default size" request.
  const raw = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid rematch request", details: parsed.error.issues }, { status: 400 });
  }

  const page = rematchCandidateJobsPage({
    candidateId,
    afterJobId: parsed.data.afterJobId,
    limit: parsed.data.limit,
  });

  return NextResponse.json(page);
}
