import { NextRequest, NextResponse } from "next/server";
import { listLatestDecisionsForDedupeKeys } from "@/db/queries/jobMatches";

/** Batch lookup for the job-list badge/filter — one query for every dedupe_key currently on the
 *  page, never one request per row. Read-only, deterministic, no AI. */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const dedupeKeys = Array.isArray(body?.dedupeKeys) ? body.dedupeKeys.filter((k: unknown) => typeof k === "string") : [];
  if (dedupeKeys.length === 0) return NextResponse.json({ decisions: {} });

  const decisions = listLatestDecisionsForDedupeKeys(dedupeKeys);
  return NextResponse.json({ decisions });
}
