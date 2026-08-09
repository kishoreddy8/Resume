import { NextRequest, NextResponse } from "next/server";
import { requireActiveCandidate } from "@/db/queries/candidates";
import { listLatestDecisionsForDedupeKeys } from "@/db/queries/jobMatches";

/** Batch lookup for the job-list badge/filter — one query for every dedupe_key currently on the
 *  page, never one request per row. Read-only, deterministic, no AI. candidateId is required
 *  explicitly, same isolation rule as every other candidate-scoped endpoint. */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const candidateId = typeof body?.candidateId === "number" ? body.candidateId : null;
  if (candidateId === null) return NextResponse.json({ error: "candidateId is required" }, { status: 400 });
  if (!requireActiveCandidate(candidateId)) return NextResponse.json({ error: "Not an active candidate" }, { status: 404 });

  const dedupeKeys = Array.isArray(body?.dedupeKeys) ? body.dedupeKeys.filter((k: unknown) => typeof k === "string") : [];
  if (dedupeKeys.length === 0) return NextResponse.json({ decisions: {} });

  const decisions = listLatestDecisionsForDedupeKeys(candidateId, dedupeKeys);
  return NextResponse.json({ decisions });
}
