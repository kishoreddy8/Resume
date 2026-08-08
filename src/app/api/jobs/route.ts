import { NextRequest, NextResponse } from "next/server";
import { listJobs } from "@/db/queries/jobs";
import type { H1bJobConfidence, PipelineStatus, SourceType } from "@/types";

const VALID_STATUSES: PipelineStatus[] = [
  "New",
  "Interested",
  "Applied",
  "Interviewing",
  "Offer",
  "Employer Rejected",
];
const VALID_H1B: H1bJobConfidence[] = [
  "Very High",
  "High",
  "Medium",
  "Low",
  "Unknown",
  "Not Sponsoring",
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
  const h1bConfidenceParam = params.getAll("h1bConfidence");

  if (status && !VALID_STATUSES.includes(status as PipelineStatus)) {
    return NextResponse.json({ error: `Invalid status: ${status}` }, { status: 400 });
  }
  if (sourceType && !VALID_SOURCES.includes(sourceType as SourceType)) {
    return NextResponse.json({ error: `Invalid sourceType: ${sourceType}` }, { status: 400 });
  }
  const h1bConfidence = h1bConfidenceParam.filter((s): s is H1bJobConfidence =>
    VALID_H1B.includes(s as H1bJobConfidence)
  );

  const jobs = listJobs({
    status: (status as PipelineStatus) ?? undefined,
    companyId: companyId ? Number(companyId) : undefined,
    sourceType: (sourceType as SourceType) ?? undefined,
    search: search ?? undefined,
    activeOnly: activeOnly === "true",
    markedForTailoring: markedForTailoring === "true",
    archived: archived === "true",
    h1bConfidence: h1bConfidence.length > 0 ? h1bConfidence : undefined,
  });

  return NextResponse.json({ jobs });
}
