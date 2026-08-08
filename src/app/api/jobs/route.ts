import { NextRequest, NextResponse } from "next/server";
import { listJobs } from "@/db/queries/jobs";
import type { H1bCombinedSignal, PipelineStatus, SourceType } from "@/types";

const VALID_STATUSES: PipelineStatus[] = [
  "New",
  "Interested",
  "Applied",
  "Interview",
  "Rejected",
  "Offer",
];
const VALID_H1B: H1bCombinedSignal[] = [
  "High",
  "Medium",
  "Low",
  "Unknown",
  "Likely",
  "Unlikely",
];
const VALID_SOURCES: SourceType[] = ["greenhouse", "ashby", "lever", "workday", "career_link"];

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;

  const status = params.get("status");
  const companyId = params.get("companyId");
  const sourceType = params.get("sourceType");
  const search = params.get("search");
  const activeOnly = params.get("activeOnly");
  const markedForTailoring = params.get("markedForTailoring");
  const archived = params.get("archived");
  const h1bSignalParam = params.getAll("h1bSignal");

  if (status && !VALID_STATUSES.includes(status as PipelineStatus)) {
    return NextResponse.json({ error: `Invalid status: ${status}` }, { status: 400 });
  }
  if (sourceType && !VALID_SOURCES.includes(sourceType as SourceType)) {
    return NextResponse.json({ error: `Invalid sourceType: ${sourceType}` }, { status: 400 });
  }
  const h1bSignal = h1bSignalParam.filter((s): s is H1bCombinedSignal =>
    VALID_H1B.includes(s as H1bCombinedSignal)
  );

  const jobs = listJobs({
    status: (status as PipelineStatus) ?? undefined,
    companyId: companyId ? Number(companyId) : undefined,
    sourceType: (sourceType as SourceType) ?? undefined,
    search: search ?? undefined,
    activeOnly: activeOnly === "true",
    markedForTailoring: markedForTailoring === "true",
    archived: archived === "true",
    h1bSignal: h1bSignal.length > 0 ? h1bSignal : undefined,
  });

  return NextResponse.json({ jobs });
}
