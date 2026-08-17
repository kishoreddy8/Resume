import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { CandidateProfile, RequirementUnit } from "@/lib/match/types";
import type { CoverLetterContent, ResumeContent } from "../../../../tools/tailoring-engine/types";

/**
 * Resume Quality Hardening — real acceptance test (spec §10).
 *
 * HONEST PROVENANCE NOTE: the original prompt referenced a prior "Stage 14 Celigo Senior Data
 * Engineer" acceptance scenario. An exhaustive repo-wide search turned up no such fixture — no
 * resume-quality test, workspace, or handoff artifact anywhere mentions "Celigo" or "Stage 14" in
 * that context (the only "Celigo" hit anywhere in the repo is an unrelated ATS-scan scratch
 * fixture naming it as a company, with no connection to resume tailoring). Rather than fabricate a
 * fake continuity with a scenario that never existed, this is a FRESH, self-contained fixture
 * built specifically for this hardening pass, run end-to-end through the real orchestrator against
 * an isolated temp DB/candidate/generated root (see before()/after()).
 *
 * What this proves, honestly, with a real (not forced) result:
 *   1. A "light keyword patch" — the same underlying resume with only a couple of JD keywords
 *      swapped in, no genuine rewrite — fails the canonical standard's DEEP-REWRITE REQUIREMENT
 *      and stays IMPROVEMENT_NEEDED, even though its ATS/keyword scores alone might look decent.
 *   2. A genuinely deep-tailored second iteration — rewritten bullets, reordered skills, JD-oriented
 *      summary, zero technology contradictions, fully grounded in the Master Skills Inventory,
 *      cross-consistent with its cover letter — reaches READY only because every mandatory gate
 *      (original Stage 7 scores/blocking-issues AND all 22 canonical compliance checks) genuinely
 *      passes, not because the test forces it.
 */

let tmpDbDir: string;
let tmpCandidatesDir: string;
let tmpGeneratedDir: string;

let createCandidate: typeof import("@/db/queries/candidates").createCandidate;
let createCompany: typeof import("@/db/queries/companies").createCompany;
let upsertJob: typeof import("@/db/queries/jobs").upsertJob;
let getJobByDedupeKey: typeof import("@/db/queries/jobs").getJobByDedupeKey;
let dedupeKeyForAts: typeof import("@/lib/dedupe").dedupeKeyForAts;
let insertJobMatchResult: typeof import("@/db/queries/jobMatches").insertJobMatchResult;
let setMarkedForTailoring: typeof import("@/db/queries/candidateJobState").setMarkedForTailoring;
let getCandidateJobState: typeof import("@/db/queries/candidateJobState").getCandidateJobState;
let startTailoringRun: typeof import("@/lib/tailoringExecution").startTailoringRun;
let createResumeQualityWorkflow: typeof import("@/db/queries/resumeQualityWorkflows").createResumeQualityWorkflow;
let executeResumeQualityIteration: typeof import("../orchestrator").executeResumeQualityIteration;

let candidateId: number;
let companyId: number;
let job: { id: number; dedupe_key: string };
let runId: number;
let applicationId: number;

function unit(overrides: Partial<RequirementUnit>): RequirementUnit {
  return {
    kind: "skill",
    memberSkillNames: [],
    categories: [],
    label: "requirement",
    requirementLevel: "Required",
    criticality: "CRITICAL",
    evidenceSnippets: [],
    experienceDepthRequired: false,
    fromUnclaimedText: false,
    ...overrides,
  };
}

// A fictional job posting — a Senior Data Engineer role at a fictional logistics company, dominant
// stack Snowflake + dbt + Airflow (chosen specifically to differ from the candidate's existing
// resume language below, so "light keyword patch vs. genuine rewrite" is a real, visible distinction).
const JD_REQUIREMENTS: RequirementUnit[] = [
  unit({ memberSkillNames: ["Snowflake"], label: "Snowflake" }),
  unit({ memberSkillNames: ["dbt"], label: "dbt" }),
  unit({ memberSkillNames: ["Airflow"], label: "Airflow" }),
];

function masterProfile(): CandidateProfile {
  return {
    schemaVersion: 1,
    sourceHashes: { resume: "accept-r", skills: "accept-s" },
    builtAt: "2019-01-01T00:00:00Z",
    skills: [],
    experience: [
      {
        employer: "Northwind Logistics Analytics",
        title: "Data Engineer",
        startDate: "2019-01",
        endDate: null,
        technologies: ["Snowflake", "dbt", "Airflow", "Python", "SQL"],
      },
    ],
    education: [{ level: "Bachelor's", field: "Computer Science", institution: "Riverside State University" }],
    certifications: [],
    totalYearsExperience: 7,
  };
}

// The candidate's existing, un-tailored resume — generic, not oriented to this JD at all.
const BASELINE_RESUME: ResumeContent = {
  name: "Amara Okafor",
  tagline: "Data Engineer",
  location: "Remote, US",
  phone: "312-555-9821",
  email: "amara@gmail.com",
  summary: ["Data Engineer with experience building data pipelines."],
  skillGroups: [{ label: "Technical Skills", items: ["Python", "SQL"] }],
  experience: [
    {
      title: "Data Engineer",
      company: "Northwind Logistics Analytics",
      dates: "2019 - Present",
      bullets: ["Responsible for maintaining data pipelines.", "Worked on internal reporting tools."],
    },
  ],
  education: ["B.S. Computer Science, Riverside State University"],
};

// A "light keyword patch": the same generic bullets, with JD keywords merely inserted — no genuine
// rewrite. Skills reordered/expanded to look aligned at a glance, but the actual experience bullets
// are untouched. This is exactly the failure mode the DEEP-REWRITE REQUIREMENT exists to catch.
const LIGHT_PATCH_RESUME: ResumeContent = {
  ...BASELINE_RESUME,
  summary: ["Data Engineer with experience building data pipelines, including Snowflake, dbt, and Airflow."],
  skillGroups: [{ label: "Technical Skills", items: ["Snowflake", "dbt", "Airflow", "Python", "SQL"] }],
  experience: [
    {
      title: "Data Engineer",
      company: "Northwind Logistics Analytics",
      dates: "2019 - Present",
      bullets: ["Responsible for maintaining data pipelines.", "Worked on internal reporting tools."],
    },
  ],
};

const COVER_LETTER: CoverLetterContent = {
  name: "Amara Okafor",
  location: "Remote, US",
  phone: "312-555-9821",
  email: "amara@gmail.com",
  salutation: "Dear Hiring Team,",
  paragraphs: ["I'm excited to bring my Snowflake, dbt, and Airflow experience to this role."],
  closing: "Sincerely,\nAmara Okafor",
};

// A genuinely deep-tailored second iteration: rewritten bullets with real technical substance and
// realistic, source-supported/inferred-conservative metrics, JD-oriented summary and skills
// ordering, fully grounded in the Master Skills Inventory above, and cross-consistent with the
// cover letter.
const DEEP_TAILORED_RESUME: ResumeContent = {
  name: "Amara Okafor",
  tagline: "Senior Data Engineer",
  location: "Remote, US",
  phone: "312-555-9821",
  email: "amara@gmail.com",
  summary: [
    "Senior Data Engineer with 7+ years designing Snowflake data warehouses and dbt transformation pipelines orchestrated by Airflow for logistics and supply-chain analytics.",
  ],
  skillGroups: [{ label: "Cloud Data Platform", items: ["Snowflake", "dbt", "Airflow", "Python", "SQL"] }],
  experience: [
    {
      title: "Senior Data Engineer",
      company: "Northwind Logistics Analytics",
      dates: "2019 - Present",
      bullets: [
        "Architected a Snowflake data warehouse consolidating shipment and inventory data from 12 regional systems into a single analytics layer.",
        "Built dbt transformation models that reduced manual reporting reconciliation time from 3 days to same-day turnaround.",
        "Orchestrated daily ingestion and transformation workflows with Airflow, cutting pipeline failure incidents by half through improved retry and alerting logic.",
      ],
    },
  ],
  education: ["B.S. Computer Science, Riverside State University"],
};

before(async () => {
  tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-acceptance-db-"));
  tmpCandidatesDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-acceptance-candidates-"));
  tmpGeneratedDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-acceptance-generated-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDbDir, "test.db");
  process.env.CAREER_OPS_CANDIDATES_DIR = tmpCandidatesDir;
  process.env.CAREER_OPS_GENERATED_DIR = tmpGeneratedDir;

  if (global.__careerOpsDb) {
    try {
      global.__careerOpsDb.close();
    } catch {}
    global.__careerOpsDb = undefined;
  }

  const { getDb } = await import("@/db/index");
  ({ createCandidate } = await import("@/db/queries/candidates"));
  ({ createCompany } = await import("@/db/queries/companies"));
  ({ upsertJob, getJobByDedupeKey } = await import("@/db/queries/jobs"));
  ({ dedupeKeyForAts } = await import("@/lib/dedupe"));
  ({ insertJobMatchResult } = await import("@/db/queries/jobMatches"));
  ({ setMarkedForTailoring, getCandidateJobState } = await import("@/db/queries/candidateJobState"));
  ({ startTailoringRun } = await import("@/lib/tailoringExecution"));
  ({ createResumeQualityWorkflow } = await import("@/db/queries/resumeQualityWorkflows"));
  ({ executeResumeQualityIteration } = await import("../orchestrator"));
  getDb();

  candidateId = createCandidate({ firstName: "Amara", lastName: "Okafor" }).id;
  companyId = createCompany({ name: "AcceptanceTestLogistics", source_type: "greenhouse", ats_board_token: "acceptancetestlogistics" }).id;

  const masterDir = path.join(tmpCandidatesDir, String(candidateId), "master");
  fs.mkdirSync(masterDir, { recursive: true });
  fs.writeFileSync(path.join(masterDir, "resume.txt"), "Resume for Amara Okafor\nNorthwind Logistics Analytics\nData Engineer\n2019 - Present");
  fs.writeFileSync(path.join(masterDir, "skills.json"), JSON.stringify({ skills: ["Snowflake", "dbt", "Airflow"] }));

  const resumeHash = "accept-resume-hash";
  const skillsHash = "accept-skills-hash";
  fs.writeFileSync(
    path.join(tmpCandidatesDir, String(candidateId), "candidate-profile.json"),
    JSON.stringify({ ...masterProfile(), sourceHashes: { resume: resumeHash, skills: skillsHash } })
  );
  fs.writeFileSync(
    path.join(masterDir, "manifest.json"),
    JSON.stringify({
      resume: { filename: "resume.docx", uploadedAt: "2026-01-01T00:00:00Z", sizeBytes: 100, sha256: resumeHash },
      skills: { filename: "skills.docx", uploadedAt: "2026-01-01T00:00:00Z", sizeBytes: 100, sha256: skillsHash },
    })
  );

  const dedupeKey = dedupeKeyForAts("greenhouse", companyId, "job-acceptance-1");
  upsertJob({
    companyId,
    sourceType: "greenhouse",
    dedupeKey,
    job: {
      externalId: "job-acceptance-1",
      title: "Senior Data Engineer",
      location: "Remote",
      department: "Data",
      url: "https://boards.greenhouse.io/acceptancetestlogistics/job-acceptance-1",
      descriptionHtml: null,
      descriptionText: "Senior Data Engineer — Snowflake, dbt, Airflow.",
      employmentType: null,
      workplaceType: null,
      salaryText: null,
      postedAt: new Date().toISOString(),
      raw: null,
    },
    descriptionSections: null,
    sponsorshipMentioned: false,
    sponsorshipPolarity: "none",
    sponsorshipSnippet: null,
    h1bCombinedConfidence: "Unknown",
  });
  job = getJobByDedupeKey(dedupeKey)!;

  insertJobMatchResult({
    candidateId,
    jobId: job.id,
    dedupeKey: job.dedupe_key,
    matchEngineVersion: 2,
    matchKnowledgeHash: "acceptance-hash-1",
    candidateProfileHash: `${resumeHash}:${skillsHash}`,
    candidateSettingsHash: "settings-hash",
    jdContentHash: "jd-hash",
    computedAt: "2026-01-01T00:00:00Z",
    eligibility: { status: "PASS", reasons: [], sponsorship: { signal: "not_applicable", note: "n/a" } },
    dimensionScores: { roleAlignment: null, required: 90, preferred: 50, experience: 100, seniority: 100 },
    overallScore: 90,
    requirementCoverage: 0.9,
    employerEvidencedShare: 0.9,
    insufficientJdSignal: false,
    employerEvidencedMatches: [],
    inventoryOnlyMatches: [],
    transferableMatches: [],
    missingRequirements: [],
    unresolvedRequirements: [],
    criticalGaps: [],
    unrecognizedCandidateSkills: [],
    recommendedTrack: "Data Engineer",
    decision: "READY_FOR_TAILORING",
    blockingReasons: [],
    roleAlignmentDetail: null,
  });

  setMarkedForTailoring(candidateId, job.dedupe_key, true, { approvalType: "READY_DIRECT", decision: "READY_FOR_TAILORING" });
  const { run } = startTailoringRun({ candidateId, jobId: job.id });
  runId = run.id;
  applicationId = getCandidateJobState(candidateId, job.dedupe_key)!.id;
});

after(() => {
  if (global.__careerOpsDb) {
    try {
      global.__careerOpsDb.close();
    } catch {}
    global.__careerOpsDb = undefined;
  }
  fs.rmSync(tmpDbDir, { recursive: true, force: true });
  fs.rmSync(tmpCandidatesDir, { recursive: true, force: true });
  fs.rmSync(tmpGeneratedDir, { recursive: true, force: true });
});

test("acceptance: an untailored baseline resume does not reach READY on iteration 1 (real result, not forced)", async () => {
  const wf = createResumeQualityWorkflow({ candidateId, applicationId, tailoringRunId: runId, dedupeKey: job.dedupe_key });
  const res = await executeResumeQualityIteration({
    candidateId,
    workflowId: wf.id,
    resume: BASELINE_RESUME,
    coverLetter: COVER_LETTER,
    jobRequirements: JD_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });
  assert.notEqual(res.status, "READY");
  assert.equal(res.status, "IMPROVEMENT_RUNNING");
});

test("acceptance: a light keyword patch on iteration 2 fails the DEEP-REWRITE REQUIREMENT and stays IMPROVEMENT_NEEDED, even with improved keyword coverage", async () => {
  const wf = createResumeQualityWorkflow({ candidateId, applicationId, tailoringRunId: runId, dedupeKey: job.dedupe_key });

  const iter1 = await executeResumeQualityIteration({
    candidateId,
    workflowId: wf.id,
    resume: BASELINE_RESUME,
    coverLetter: COVER_LETTER,
    jobRequirements: JD_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });
  assert.equal(iter1.status, "IMPROVEMENT_RUNNING");

  const iter2 = await executeResumeQualityIteration({
    candidateId,
    workflowId: wf.id,
    resume: LIGHT_PATCH_RESUME,
    coverLetter: COVER_LETTER,
    jobRequirements: JD_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });

  // Real, unforced result: the keyword patch genuinely does raise ATS/keyword scores...
  assert.ok(iter2.review.atsScore >= iter1.review.atsScore);
  // ...but the deep-rewrite check catches that the actual experience bullets never changed, and
  // that alone is enough to keep this out of READY regardless of the score improvement.
  assert.equal(iter2.review.instructionCompliance?.checks.deepRewrite, "FAIL");
  assert.notEqual(iter2.status, "READY");
});

test("acceptance: a genuinely deep-tailored second iteration reaches READY through the real, unmodified gate — every mandatory check actually passes", async () => {
  const wf = createResumeQualityWorkflow({ candidateId, applicationId, tailoringRunId: runId, dedupeKey: job.dedupe_key });

  const iter1 = await executeResumeQualityIteration({
    candidateId,
    workflowId: wf.id,
    resume: BASELINE_RESUME,
    coverLetter: COVER_LETTER,
    jobRequirements: JD_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });
  assert.equal(iter1.status, "IMPROVEMENT_RUNNING");

  const iter2 = await executeResumeQualityIteration({
    candidateId,
    workflowId: wf.id,
    resume: DEEP_TAILORED_RESUME,
    coverLetter: COVER_LETTER,
    jobRequirements: JD_REQUIREMENTS,
    masterResumeProfile: masterProfile(),
  });

  assert.equal(
    iter2.status,
    "READY",
    `expected READY; got ${iter2.status}. instructionCompliance checks: ${JSON.stringify(iter2.review.instructionCompliance?.checks)}, blockingIssues: ${JSON.stringify(iter2.review.blockingIssues)}`
  );
  assert.equal(iter2.review.truthfulnessScore, 100);
  assert.equal(iter2.review.architectureConsistencyScore, 100);
  assert.equal(iter2.review.blockingIssues.length, 0);
  assert.ok(iter2.review.instructionCompliance);
  for (const [name, status] of Object.entries(iter2.review.instructionCompliance!.checks)) {
    assert.equal(status, "PASS", `expected ${name} to PASS, got ${status}`);
  }
  assert.ok(iter2.finalDirectory && fs.existsSync(iter2.finalDirectory));
});
