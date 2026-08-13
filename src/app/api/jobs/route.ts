import { NextRequest, NextResponse } from "next/server";
import { listJobs } from "@/db/queries/jobs";
import type {
  EmploymentTypeNormalized,
  H1bJobConfidence,
  PipelineStatus,
  Seniority,
  SourceType,
  WorkplaceTypeNormalized,
} from "@/types";

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
const VALID_SOURCES: SourceType[] = [
  "greenhouse", "ashby", "lever", "workday", "smartrecruiters", "adp_wfn", "adp_rm", "eightfold", "cornerstone", "avature", "paylocity", "icims", "ukg_pro", "bamboohr", "oracle_recruiting_cloud", "workable", "rippling", "paycom", "jazzhr", "jobvite", "breezy", "teamtailor", "applicantpro", "pinpoint", "clearcompany", "personio", "applicantstack", "comeet", "cats", "gohire", "newton", "silkroad", "jobdiva", "taleo", "career_link",
];
const VALID_WORKPLACE_TYPES: WorkplaceTypeNormalized[] = ["Remote", "Hybrid", "Onsite"];
const VALID_EMPLOYMENT_TYPES: EmploymentTypeNormalized[] = [
  "Full-Time",
  "Part-Time",
  "Contract",
  "Temporary",
  "Internship",
  "Contract-to-Hire",
];
const VALID_SENIORITY: Seniority[] = [
  "Intern",
  "Entry",
  "Junior",
  "Mid",
  "Senior",
  "Staff",
  "Principal",
  "Lead",
  "Manager",
  "Director",
];

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
  const workplaceType = params.get("workplaceType");
  const employmentType = params.get("employmentType");
  const seniority = params.get("seniority");
  const salaryAvailable = params.get("salaryAvailable");
  const clearanceRequired = params.get("clearanceRequired");
  const candidateIdParam = params.get("candidateId");
  const candidateId = candidateIdParam && Number.isInteger(Number(candidateIdParam)) ? Number(candidateIdParam) : undefined;

  if (status && !VALID_STATUSES.includes(status as PipelineStatus)) {
    return NextResponse.json({ error: `Invalid status: ${status}` }, { status: 400 });
  }
  if (sourceType && !VALID_SOURCES.includes(sourceType as SourceType)) {
    return NextResponse.json({ error: `Invalid sourceType: ${sourceType}` }, { status: 400 });
  }
  if (workplaceType && !VALID_WORKPLACE_TYPES.includes(workplaceType as WorkplaceTypeNormalized)) {
    return NextResponse.json({ error: `Invalid workplaceType: ${workplaceType}` }, { status: 400 });
  }
  if (employmentType && !VALID_EMPLOYMENT_TYPES.includes(employmentType as EmploymentTypeNormalized)) {
    return NextResponse.json({ error: `Invalid employmentType: ${employmentType}` }, { status: 400 });
  }
  if (seniority && !VALID_SENIORITY.includes(seniority as Seniority)) {
    return NextResponse.json({ error: `Invalid seniority: ${seniority}` }, { status: 400 });
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
    workplaceType: (workplaceType as WorkplaceTypeNormalized) ?? undefined,
    employmentType: (employmentType as EmploymentTypeNormalized) ?? undefined,
    seniority: (seniority as Seniority) ?? undefined,
    salaryAvailable: salaryAvailable === "true",
    clearanceRequired: clearanceRequired === "true",
    candidateId,
  });

  return NextResponse.json({ jobs });
}
