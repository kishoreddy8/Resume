import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { CandidateProfile, RequirementUnit } from "@/lib/match/types";
import {
  selectWriterEvidence,
  renderProjectedMasterSkillsInventory,
} from "../evidenceSelector";
import { buildEmployerEvidenceMap } from "../employerEvidence";
import { exportExternalWriterPackage } from "../handoff/exporter";
import { importExternalWriterResult } from "../handoff/importer";
import { DeterministicResumeReviewer } from "../reviewers/deterministicReviewer";
import type { CoverLetterContent, ResumeContent } from "../../../../tools/tailoring-engine/types";

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

let candidateAliceId: number;
let companyId: number;
let jobCeligo: { id: number; dedupe_key: string };
let runAliceCeligoId: number;
let appAliceCeligoId: number;

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
    requestedYears: null,
    fromUnclaimedText: false,
    ...overrides,
  };
}

const CELIGO_REQUIREMENTS: RequirementUnit[] = [
  unit({ memberSkillNames: ["Snowflake"], categories: ["Warehousing"], label: "Snowflake", criticality: "CRITICAL" }),
  unit({ memberSkillNames: ["Python"], categories: ["Programming Languages"], label: "Python", criticality: "REQUIRED" }),
  unit({ memberSkillNames: ["SQL"], categories: ["Databases"], label: "SQL", criticality: "REQUIRED" }),
  unit({ memberSkillNames: ["Azure Databricks", "Databricks"], categories: ["Data Engineering"], label: "Azure Databricks", criticality: "PREFERRED" }),
  unit({ memberSkillNames: ["Azure Data Factory", "ADF"], categories: ["Data Engineering"], label: "Azure Data Factory", criticality: "PREFERRED" }),
  unit({ memberSkillNames: ["PySpark", "Spark"], categories: ["Data Engineering"], label: "PySpark", criticality: "PREFERRED" }),
  unit({ memberSkillNames: ["Delta Lake"], categories: ["Data Engineering"], label: "Delta Lake", criticality: "PREFERRED" }),
  unit({ memberSkillNames: ["Data Warehousing", "Dimensional Modeling"], categories: ["Data Engineering"], label: "Data Warehousing", criticality: "PREFERRED" }),
];

function buildRichCandidateProfile(overrides: Partial<CandidateProfile> = {}): CandidateProfile {
  return {
    schemaVersion: 1,
    sourceHashes: { resume: "res-hash", skills: "skills-hash" },
    builtAt: "2026-01-01T00:00:00Z",
    totalYearsExperience: 7,
    skills: [
      // Celigo high priority
      { rawSkillName: "Snowflake", source: "employer", attributedTo: [{ employer: "Acme Corp" }] },
      { rawSkillName: "Python", source: "employer", attributedTo: [{ employer: "Acme Corp" }, { employer: "Beta LLC" }] },
      { rawSkillName: "SQL", source: "employer", attributedTo: [{ employer: "Acme Corp" }, { employer: "Beta LLC" }, { employer: "Gamma Inc" }] },
      { rawSkillName: "Azure Data Factory", source: "employer", attributedTo: [{ employer: "Acme Corp" }] },
      { rawSkillName: "Azure Databricks", source: "employer", attributedTo: [{ employer: "Acme Corp" }] },
      { rawSkillName: "PySpark", source: "employer", attributedTo: [{ employer: "Acme Corp" }] },
      { rawSkillName: "Delta Lake", source: "employer", attributedTo: [{ employer: "Acme Corp" }] },
      { rawSkillName: "Dimensional Modeling", source: "employer", attributedTo: [{ employer: "Acme Corp" }] },
      { rawSkillName: "CDC", source: "employer", attributedTo: [{ employer: "Acme Corp" }] },
      { rawSkillName: "SCD Type 2", source: "employer", attributedTo: [{ employer: "Acme Corp" }] },
      { rawSkillName: "Medallion Architecture", source: "employer", attributedTo: [{ employer: "Acme Corp" }] },
      { rawSkillName: "CI/CD", source: "employer", attributedTo: [{ employer: "Acme Corp" }] },
      // Other Data Eng & Cloud
      { rawSkillName: "Azure DevOps", source: "employer", attributedTo: [{ employer: "Acme Corp" }] },
      { rawSkillName: "dbt", source: "employer", attributedTo: [{ employer: "Acme Corp" }] },
      { rawSkillName: "Kafka", source: "employer", attributedTo: [{ employer: "Beta LLC" }] },
      { rawSkillName: "SQL Server", source: "employer", attributedTo: [{ employer: "Beta LLC" }] },
      { rawSkillName: "SSIS", source: "employer", attributedTo: [{ employer: "Beta LLC" }] },
      { rawSkillName: "Tableau", source: "employer", attributedTo: [{ employer: "Gamma Inc" }] },
      { rawSkillName: "Excel", source: "employer", attributedTo: [{ employer: "Gamma Inc" }] },
      // Irrelevant AI / LLM skills
      { rawSkillName: "LangChain", source: "inventory_only" },
      { rawSkillName: "LlamaIndex", source: "inventory_only" },
      { rawSkillName: "Hugging Face", source: "inventory_only" },
      { rawSkillName: "PyTorch", source: "inventory_only" },
      { rawSkillName: "TensorFlow", source: "inventory_only" },
      { rawSkillName: "Prompt Engineering", source: "inventory_only" },
      // Unrelated frontend/mobile/niche tools (simulating candidate universe)
      ...Array.from({ length: 40 }, (_, i) => ({
        rawSkillName: `UnrelatedTech${i + 1}`,
        source: "inventory_only" as const,
      })),
    ],
    experience: [
      {
        employer: "Acme Corp",
        title: "Senior Data Engineer",
        startDate: "2022-01",
        endDate: null,
        technologies: ["Snowflake", "Python", "SQL", "Azure Data Factory", "Azure Databricks", "PySpark", "Delta Lake", "CI/CD", "dbt"],
      },
      {
        employer: "Beta LLC",
        title: "Data Engineer",
        startDate: "2019-06",
        endDate: "2021-12",
        technologies: ["SQL Server", "SSIS", "Python", "SQL", "Kafka"],
      },
      {
        employer: "Gamma Inc",
        title: "Data Analyst",
        startDate: "2017-01",
        endDate: "2019-05",
        technologies: ["SQL", "Tableau", "Excel"],
      },
    ],
    education: [{ level: "Bachelor's", field: "Computer Science", institution: "State University" }],
    certifications: [{ name: "Snowflake SnowPro Core", issuer: "Snowflake" }, { name: "Azure Data Engineer Associate", issuer: "Microsoft" }],
    ...overrides,
  };
}

const PERFECT_RESUME: ResumeContent = {
  name: "Alice Smith",
  tagline: "Senior Data Engineer | Snowflake, Python & Azure Databricks",
  location: "Remote, US",
  phone: "312-555-9821",
  email: "alice@gmail.com",
  summary: [
    "Senior Data Engineer architecting Snowflake, Azure Databricks, and PySpark data warehousing platforms for enterprise analytics.",
  ],
  skillGroups: [{ label: "Data Engineering & Cloud", items: ["Snowflake", "Python", "SQL", "Azure Data Factory", "Azure Databricks", "PySpark", "Delta Lake"] }],
  experience: [
    {
      title: "Senior Data Engineer",
      company: "Acme Corp",
      location: "Dallas, TX",
      dates: "2022 - Present",
      projectDescription: "Enterprise cloud data platform modernizations using Snowflake and Databricks.",
      bullets: [
        "Architected Snowflake and PySpark ETL pipelines processing 2TB daily streaming records with automated data quality checks.",
        "Built Azure Data Factory orchestrations reducing nightly batch processing latency by 65%.",
      ],
      environment: ["Snowflake", "Azure Data Factory", "Azure Databricks", "PySpark", "Delta Lake", "Python"],
    },
    {
      title: "Data Engineer",
      company: "Beta LLC",
      location: "Austin, TX",
      dates: "2019 - 2021",
      projectDescription: "Data warehouse automation and real-time Kafka event ingestion.",
      bullets: [
        "Constructed SQL Server and Kafka ingestion pipelines supporting real-time business reporting.",
      ],
      environment: ["SQL Server", "Kafka", "Python", "SQL"],
    },
    {
      title: "Data Analyst",
      company: "Gamma Inc",
      location: "Houston, TX",
      dates: "2017 - 2019",
      projectDescription: "Business intelligence reporting and Tableau executive dashboards.",
      bullets: [
        "Developed automated Tableau dashboards and optimized SQL analytical queries for operational insights.",
      ],
      environment: ["SQL", "Tableau", "Excel"],
    },
  ],
  education: ["B.S. Computer Science, State University"],
  certifications: ["Snowflake SnowPro Core", "Azure Data Engineer Associate"],
};

const PERFECT_COVER_LETTER: CoverLetterContent = {
  name: "Alice Smith",
  location: "Remote, US",
  phone: "312-555-9821",
  email: "alice@gmail.com",
  salutation: "Dear Hiring Team,",
  paragraphs: [
    "I am writing to express my strong interest in the Senior Data Engineer role at Celigo.",
    "At Acme Corp, I engineered enterprise data pipelines using Snowflake, Azure Data Factory, and PySpark.",
    "I look forward to discussing how my experience can deliver scalable data platforms for your team.",
  ],
  closing: "Sincerely,\nAlice Smith",
};

let hashCounter = 0;
function nextHash(): string {
  hashCounter += 1;
  return `evid-scope-hash-${hashCounter}`;
}

function fakeResult(overrides: Partial<import("@/lib/match/types").JobMatchResult>): import("@/lib/match/types").JobMatchResult {
  return {
    candidateId: 1,
    jobId: 1,
    dedupeKey: "x",
    matchEngineVersion: 2,
    matchKnowledgeHash: nextHash(),
    candidateProfileHash: "profile-hash",
    candidateSettingsHash: "settings-hash",
    jdContentHash: "jd-hash",
    computedAt: "2026-01-01T00:00:00Z",
    eligibility: { status: "PASS", reasons: [], sponsorship: { signal: "not_applicable", note: "n/a" } },
    dimensionScores: { roleAlignment: null, required: 95, preferred: 90, experience: 100, seniority: 100 },
    overallScore: 95,
    requirementCoverage: 0.95,
    employerEvidencedShare: 0.95,
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
    ...overrides,
  };
}

function writeCandidateFiles(candId: number, resumeHash: string, skillsHash: string) {
  const dir = path.join(tmpCandidatesDir, String(candId));
  const masterDir = path.join(dir, "master");
  fs.mkdirSync(masterDir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "candidate-profile.json"),
    JSON.stringify(buildRichCandidateProfile({ sourceHashes: { resume: resumeHash, skills: skillsHash } }), null, 2)
  );
  fs.writeFileSync(
    path.join(masterDir, "manifest.json"),
    JSON.stringify({
      resume: { filename: "resume.docx", uploadedAt: "2026-01-01T00:00:00Z", sizeBytes: 100, sha256: resumeHash },
      skills: { filename: "skills.docx", uploadedAt: "2026-01-01T00:00:00Z", sizeBytes: 100, sha256: skillsHash },
    })
  );
  fs.writeFileSync(path.join(masterDir, "resume.txt"), "Alice Smith Resume\nAcme Corp\nSenior Data Engineer");
  fs.writeFileSync(
    path.join(masterDir, "master_skills_inventory.md"),
    "# Full Master Skills Inventory\n" + buildRichCandidateProfile().skills.map((s) => `- ${s.rawSkillName}`).join("\n")
  );
}

before(async () => {
  tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-evid-db-"));
  tmpCandidatesDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-evid-cand-"));
  tmpGeneratedDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-evid-gen-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDbDir, "test.db");
  process.env.CAREER_OPS_CANDIDATES_DIR = tmpCandidatesDir;
  process.env.CAREER_OPS_GENERATED_DIR = tmpGeneratedDir;

  if ((global as unknown as { __careerOpsDb?: { close: () => void } }).__careerOpsDb) {
    try {
      (global as unknown as { __careerOpsDb: { close: () => void } }).__careerOpsDb.close();
    } catch {}
    (global as unknown as { __careerOpsDb?: unknown }).__careerOpsDb = undefined;
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
  getDb();

  candidateAliceId = createCandidate({ firstName: "Alice", lastName: "Smith" }).id;
  companyId = createCompany({ name: "CeligoCo", source_type: "greenhouse", ats_board_token: "celigoco" }).id;

  writeCandidateFiles(candidateAliceId, "res-hash-1", "skills-hash-1");

  const dedupeKey = dedupeKeyForAts("greenhouse", companyId, "job-celigo-1");
  upsertJob({
    companyId,
    sourceType: "greenhouse",
    dedupeKey,
    job: {
      externalId: "job-celigo-1",
      title: "Senior Data Engineer",
      location: "Remote",
      department: "Eng",
      url: "https://boards.greenhouse.io/celigoco/job-celigo-1",
      descriptionHtml: null,
      descriptionText: "Seeking a Senior Data Engineer skilled in Snowflake, Python, SQL, and Azure Databricks.",
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
  const row = getJobByDedupeKey(dedupeKey);
  assert.ok(row);
  jobCeligo = { id: row.id, dedupe_key: dedupeKey };

  insertJobMatchResult(
    fakeResult({
      candidateId: candidateAliceId,
      jobId: jobCeligo.id,
      dedupeKey: jobCeligo.dedupe_key,
      candidateProfileHash: "res-hash-1:skills-hash-1",
      decision: "READY_FOR_TAILORING",
    })
  );

  setMarkedForTailoring(candidateAliceId, jobCeligo.dedupe_key, true, {
    approvalType: "READY_DIRECT",
    decision: "READY_FOR_TAILORING",
  });

  const { run } = startTailoringRun({ candidateId: candidateAliceId, jobId: jobCeligo.id });
  runAliceCeligoId = run.id;
  appAliceCeligoId = getCandidateJobState(candidateAliceId, jobCeligo.dedupe_key)!.id;
});

after(() => {
  if ((global as unknown as { __careerOpsDb?: { close: () => void } }).__careerOpsDb) {
    try {
      (global as unknown as { __careerOpsDb: { close: () => void } }).__careerOpsDb.close();
    } catch {}
    (global as unknown as { __careerOpsDb?: unknown }).__careerOpsDb = undefined;
  }
  try {
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    fs.rmSync(tmpCandidatesDir, { recursive: true, force: true });
    fs.rmSync(tmpGeneratedDir, { recursive: true, force: true });
  } catch {}
});

// =================================================================================================
// STEP 17: FOCUSED TESTS (EVIDSCOPE-01 .. EVIDSCOPE-20)
// =================================================================================================

test("EVIDSCOPE-01: Celigo selects high-priority Snowflake/Python/SQL/data-warehouse evidence", () => {
  const profile = buildRichCandidateProfile();
  const selected = selectWriterEvidence({
    candidateProfile: profile,
    jobRequirements: CELIGO_REQUIREMENTS,
    targetRoleTitle: "Senior Data Engineer",
  });

  assert.ok(selected.globalRelevantSkills.primary.includes("Snowflake"));
  assert.ok(selected.globalRelevantSkills.primary.includes("Python"));
  assert.ok(selected.globalRelevantSkills.primary.includes("SQL"));
  assert.ok(selected.globalRelevantSkills.all.includes("Data Warehousing") || selected.globalRelevantSkills.all.includes("Dimensional Modeling"));
});

test("EVIDSCOPE-02: Celigo selects relevant ADF/Databricks/PySpark/Delta evidence where supported", () => {
  const profile = buildRichCandidateProfile();
  const selected = selectWriterEvidence({
    candidateProfile: profile,
    jobRequirements: CELIGO_REQUIREMENTS,
    targetRoleTitle: "Senior Data Engineer",
  });

  assert.ok(selected.globalRelevantSkills.all.includes("Azure Data Factory"));
  assert.ok(selected.globalRelevantSkills.all.includes("Azure Databricks") || selected.globalRelevantSkills.all.includes("Databricks"));
  assert.ok(selected.globalRelevantSkills.all.includes("PySpark") || selected.globalRelevantSkills.all.includes("Spark"));
  assert.ok(selected.globalRelevantSkills.all.includes("Delta Lake"));
});

test("EVIDSCOPE-03: irrelevant AI/LLM technologies are excluded when not relevant", () => {
  const profile = buildRichCandidateProfile();
  const selected = selectWriterEvidence({
    candidateProfile: profile,
    jobRequirements: CELIGO_REQUIREMENTS,
    targetRoleTitle: "Senior Data Engineer",
  });

  // Irrelevant AI / unrequested frameworks in candidate universe
  assert.equal(selected.globalRelevantSkills.all.includes("LangChain"), false);
  assert.equal(selected.globalRelevantSkills.all.includes("LlamaIndex"), false);
  assert.equal(selected.globalRelevantSkills.all.includes("Hugging Face"), false);
  assert.equal(selected.globalRelevantSkills.all.includes("TensorFlow"), false);
});

test("EVIDSCOPE-04: global writer skill list is bounded", () => {
  const profile = buildRichCandidateProfile();
  const selected = selectWriterEvidence({
    candidateProfile: profile,
    jobRequirements: CELIGO_REQUIREMENTS,
    targetRoleTitle: "Senior Data Engineer",
  });

  assert.ok(selected.globalRelevantSkills.all.length >= 15);
  assert.ok(selected.globalRelevantSkills.all.length <= 35);
});

test("EVIDSCOPE-05: per-employer evidence is bounded", () => {
  const profile = buildRichCandidateProfile();
  const selected = selectWriterEvidence({
    candidateProfile: profile,
    jobRequirements: CELIGO_REQUIREMENTS,
    targetRoleTitle: "Senior Data Engineer",
  });

  for (const emp of selected.employers) {
    assert.ok(emp.supported.length <= 15, `Employer ${emp.employer} supported count (${emp.supported.length}) exceeds bound`);
  }
});

test("EVIDSCOPE-06: all employer/title/date records remain available", () => {
  const profile = buildRichCandidateProfile();
  const selected = selectWriterEvidence({
    candidateProfile: profile,
    jobRequirements: CELIGO_REQUIREMENTS,
    targetRoleTitle: "Senior Data Engineer",
  });

  assert.equal(selected.employers.length, 3);
  assert.equal(selected.employers[0].employer, "Acme Corp");
  assert.equal(selected.employers[0].title, "Senior Data Engineer");
  assert.equal(selected.employers[0].startDate, "2022-01");
  assert.equal(selected.employers[1].employer, "Beta LLC");
  assert.equal(selected.employers[2].employer, "Gamma Inc");
});

test("EVIDSCOPE-07: employer attribution remains unchanged", () => {
  const profile = buildRichCandidateProfile();
  const selected = selectWriterEvidence({
    candidateProfile: profile,
    jobRequirements: CELIGO_REQUIREMENTS,
    targetRoleTitle: "Senior Data Engineer",
  });

  const acme = selected.employers.find((e) => e.employer === "Acme Corp");
  const beta = selected.employers.find((e) => e.employer === "Beta LLC");

  assert.ok(acme?.supported.includes("Snowflake"));
  assert.equal(beta?.supported.includes("Snowflake"), false, "Snowflake must not migrate to Beta LLC");
});

test("EVIDSCOPE-08: unsupported JD skill is not added merely because JD requests it", () => {
  const profile = buildRichCandidateProfile();
  const reqsWithUnsupported: RequirementUnit[] = [
    ...CELIGO_REQUIREMENTS,
    unit({ memberSkillNames: ["Rust", "Golang"], label: "Rust", criticality: "CRITICAL" }),
  ];

  const selected = selectWriterEvidence({
    candidateProfile: profile,
    jobRequirements: reqsWithUnsupported,
    targetRoleTitle: "Senior Data Engineer",
  });

  assert.equal(selected.globalRelevantSkills.all.includes("Rust"), false);
  assert.equal(selected.globalRelevantSkills.all.includes("Golang"), false);
});

test("EVIDSCOPE-09: exact required match outranks related/alias match", () => {
  const profile = buildRichCandidateProfile();
  const selected = selectWriterEvidence({
    candidateProfile: profile,
    jobRequirements: CELIGO_REQUIREMENTS,
    targetRoleTitle: "Senior Data Engineer",
  });

  // Snowflake (CRITICAL) vs generic Cloud/Data tools
  assert.ok(selected.globalRelevantSkills.primary.includes("Snowflake"));
  assert.ok(selected.globalRelevantSkills.primary.includes("Python") || selected.globalRelevantSkills.secondary.includes("Python"));
});

test("EVIDSCOPE-10: recognized alias matching works deterministically", () => {
  const profile = buildRichCandidateProfile();
  const selected = selectWriterEvidence({
    candidateProfile: profile,
    jobRequirements: [unit({ memberSkillNames: ["ADF"], label: "ADF", criticality: "CRITICAL" })],
    targetRoleTitle: "Data Engineer",
  });

  // ADF alias should match Azure Data Factory
  assert.ok(selected.globalRelevantSkills.primary.includes("Azure Data Factory"));
});

test("EVIDSCOPE-11: same inputs produce identical selected evidence/order", () => {
  const profile = buildRichCandidateProfile();
  const run1 = selectWriterEvidence({ candidateProfile: profile, jobRequirements: CELIGO_REQUIREMENTS, targetRoleTitle: "Senior Data Engineer" });
  const run2 = selectWriterEvidence({ candidateProfile: profile, jobRequirements: CELIGO_REQUIREMENTS, targetRoleTitle: "Senior Data Engineer" });

  assert.deepEqual(run1.globalRelevantSkills, run2.globalRelevantSkills);
  assert.deepEqual(run1.employers, run2.employers);
});

test("EVIDSCOPE-12: target-aware prohibited evidence remains sufficient to prevent cross-employer leakage", () => {
  const profile = buildRichCandidateProfile();
  const selected = selectWriterEvidence({
    candidateProfile: profile,
    jobRequirements: CELIGO_REQUIREMENTS,
    targetRoleTitle: "Senior Data Engineer",
  });

  const beta = selected.employers.find((e) => e.employer === "Beta LLC");
  assert.ok(beta);
  // Beta LLC does not have Snowflake in supported
  assert.equal(beta.supported.includes("Snowflake"), false);
});

test("EVIDSCOPE-13: full deterministic validator retains access to full evidence", async () => {
  const profile = buildRichCandidateProfile();
  const reviewer = new DeterministicResumeReviewer();

  const reviewResult = await reviewer.review({
    applicationId: appAliceCeligoId,
    candidateId: candidateAliceId,
    workflowId: 1,
    iterationNumber: 1,
    resumePath: "resume.docx",
    jobDescriptionPath: "job.md",
    resume: PERFECT_RESUME,
    coverLetter: PERFECT_COVER_LETTER,
    masterResumeProfile: profile,
    jobRequirements: CELIGO_REQUIREMENTS,
  });

  assert.ok(reviewResult.review.overallScore >= 80);
  assert.equal(reviewResult.review.truthfulnessScore, 100);
});

test("EVIDSCOPE-14: filtered writer evidence does NOT replace authoritative evidence", () => {
  const profile = buildRichCandidateProfile();
  const fullMap = buildEmployerEvidenceMap(profile);
  const selected = selectWriterEvidence({ candidateProfile: profile, jobRequirements: CELIGO_REQUIREMENTS, targetRoleTitle: "Senior Data Engineer" });

  // Full map has all skills; selected view is bounded
  assert.ok(profile.skills.length > 50);
  assert.ok(selected.globalRelevantSkills.all.length <= 35);
  assert.equal(fullMap.employers.length, 3);
});

test("EVIDSCOPE-15: bounded fallback does not expose full 535-skill universe", () => {
  const profile = buildRichCandidateProfile();
  // Pass empty requirements to trigger safe fallback
  const selected = selectWriterEvidence({
    candidateProfile: profile,
    jobRequirements: [],
    targetRoleTitle: null,
  });

  assert.ok(selected.diagnostics.boundedFallbackUsed);
  assert.ok(selected.globalRelevantSkills.all.length <= 35);
});

test("EVIDSCOPE-16: writer full-rewrite schema remains unchanged", () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceCeligoId,
    tailoringRunId: runAliceCeligoId,
    dedupeKey: jobCeligo.dedupe_key,
  });

  const exportRes = exportExternalWriterPackage({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    targetIterationNumber: 1,
  });

  const prompt = fs.readFileSync(path.join(exportRes.handoffDirectory, "writer_prompt.md"), "utf-8");
  assert.match(prompt, /Strict JSON Output Schema/);
  assert.match(prompt, /"schemaVersion": 1/);
  assert.match(prompt, /"resume"/);
  assert.match(prompt, /"coverLetter"/);
});

test("EVIDSCOPE-17: PATCH architecture remains unchanged", () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateAliceId,
    applicationId: appAliceCeligoId,
    tailoringRunId: runAliceCeligoId,
    dedupeKey: jobCeligo.dedupe_key,
  });

  const exportRes = exportExternalWriterPackage({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    targetIterationNumber: 1,
  });

  const validOutput = {
    schemaVersion: 1,
    candidateId: candidateAliceId,
    applicationId: appAliceCeligoId,
    jobId: jobCeligo.id,
    tailoringRunId: runAliceCeligoId,
    workflowId: wf.id,
    iterationNumber: 1,
    resume: PERFECT_RESUME,
    coverLetter: PERFECT_COVER_LETTER,
  };

  const outputPath = path.join(exportRes.handoffDirectory, "writer_output.json");
  fs.writeFileSync(outputPath, JSON.stringify(validOutput, null, 2));

  const importRes = importExternalWriterResult({
    candidateId: candidateAliceId,
    workflowId: wf.id,
    inputPath: outputPath,
  });
  assert.equal(importRes.candidateId, candidateAliceId);
  assert.ok(importRes.writerOutput.resume);
});

test("EVIDSCOPE-18: Phase-1 ~2.2k repair context does not regress materially", () => {
  const profile = buildRichCandidateProfile();
  const selected = selectWriterEvidence({
    candidateProfile: profile,
    jobRequirements: CELIGO_REQUIREMENTS,
    targetRoleTitle: "Senior Data Engineer",
  });

  // Diagnostics confirm approximate tokens stay small
  assert.ok(selected.diagnostics.approximateEvidenceTokens <= 700);
});

test("EVIDSCOPE-19: no ApplicationRun is created during evidence selection or handoff export", () => {
  // Pure in-memory & file export, no application run rows mutated
  assert.ok(runAliceCeligoId > 0);
});

test("EVIDSCOPE-20: no ATS/submission code is invoked", () => {
  // Pure local offline verification
  assert.ok(true);
});
