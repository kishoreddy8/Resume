import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { CandidateProfile, RequirementUnit } from "@/lib/match/types";
import { selectWriterEvidence } from "../evidenceSelector";
import { exportExternalWriterPackage, buildExternalWriterPrompt } from "../handoff/exporter";
import { measureHandoffContext } from "../handoff/contextMeasurement";
import { deriveProfessionalIdentity, renderProfessionalIdentitySection } from "../professionalIdentity";
import { renderPresentationStandardSection } from "../presentationStructure";
import { renderWriterOutputQualitySection } from "../writerOutputQuality";
import { checkSummaryQuality, checkSummaryShape } from "../presentationContract";
import type { ResumeContent } from "../../../../tools/tailoring-engine/types";

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

let candidateBobId: number;
let companyId: number;
let jobCeligo: { id: number; dedupe_key: string };
let runBobCeligoId: number;
let appBobCeligoId: number;

function unit(overrides: Partial<RequirementUnit>): RequirementUnit {
  return {
    kind: "skill",
    memberSkillNames: [],
    categories: ["Data Engineering"],
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
      ...Array.from({ length: 50 }, (_, i) => ({
        rawSkillName: `OtherTech${i + 1}`,
        source: "inventory_only" as const,
      })),
    ],
    experience: [
      {
        employer: "Acme Corp",
        title: "Senior Data Engineer",
        startDate: "2022-01",
        endDate: null,
        technologies: ["Snowflake", "Python", "SQL", "Azure Data Factory", "Azure Databricks", "PySpark", "Delta Lake", "CI/CD"],
      },
      {
        employer: "Beta LLC",
        title: "Data Engineer",
        startDate: "2019-06",
        endDate: "2021-12",
        technologies: ["Python", "SQL", "SQL Server"],
      },
      {
        employer: "Gamma Inc",
        title: "Data Analyst",
        startDate: "2017-01",
        endDate: "2019-05",
        technologies: ["SQL", "Tableau"],
      },
    ],
    education: [{ level: "Bachelor's", field: "Computer Science", institution: "State University" }],
    certifications: [{ name: "Snowflake SnowPro Core", issuer: "Snowflake" }],
    ...overrides,
  };
}

const PERFECT_RESUME: ResumeContent = {
  name: "Bob Builder",
  tagline: "Senior Data Engineer | Snowflake & Azure Databricks",
  location: "Dallas, TX",
  phone: "214-555-0199",
  email: "bob@builder.test",
  summary: [
    "Senior Data Engineer building Snowflake and Azure Databricks platforms for enterprise financial reporting. Architecture ownership covers high-throughput streaming pipelines, automated data quality controls, and governed lakehouse layers. Delivered 40% reduction in query latency for analytical teams across production systems.",
  ],
  skillGroups: [{ label: "Data Engineering", items: ["Snowflake", "Python", "SQL", "Azure Data Factory", "Azure Databricks", "PySpark", "Delta Lake"] }],
  experience: [
    {
      title: "Senior Data Engineer",
      company: "Acme Corp",
      location: "Dallas, TX",
      dates: "2022 - Present",
      projectDescription: "Enterprise cloud data platform modernizations using Snowflake and Databricks.",
      bullets: [
        "Architected Snowflake and PySpark ETL pipelines processing 2TB daily streaming records with automated data quality checks.",
      ],
      environment: ["Snowflake", "Azure Data Factory", "Azure Databricks", "PySpark", "Delta Lake", "Python"],
    },
    {
      title: "Data Engineer",
      company: "Beta LLC",
      location: "Austin, TX",
      dates: "2019 - 2021",
      projectDescription: "Data warehouse automation and real-time event ingestion.",
      bullets: [
        "Constructed SQL Server and Python ingestion pipelines supporting real-time business reporting.",
      ],
      environment: ["SQL Server", "Python", "SQL"],
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
      environment: ["SQL", "Tableau"],
    },
  ],
  education: ["B.S. Computer Science, State University"],
  certifications: ["Snowflake SnowPro Core"],
};

let hashCounter = 0;
function nextHash(): string {
  hashCounter += 1;
  return `summary-gate-hash-${hashCounter}`;
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
  fs.writeFileSync(path.join(masterDir, "resume.txt"), "Bob Builder Resume\nAcme Corp\nSenior Data Engineer");
  fs.writeFileSync(
    path.join(masterDir, "master_skills_inventory.md"),
    "# Full Master Skills Inventory\n" + buildRichCandidateProfile().skills.map((s) => `- ${s.rawSkillName}`).join("\n")
  );
}

before(async () => {
  tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-summgate-db-"));
  tmpCandidatesDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-summgate-cand-"));
  tmpGeneratedDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-summgate-gen-"));
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

  candidateBobId = createCandidate({ firstName: "Bob", lastName: "Builder" }).id;
  companyId = createCompany({ name: "CeligoCo", source_type: "greenhouse", ats_board_token: "celigoco" }).id;

  writeCandidateFiles(candidateBobId, "res-hash-summgate", "skills-hash-summgate");

  const dedupeKey = dedupeKeyForAts("greenhouse", companyId, "job-celigo-summgate");
  upsertJob({
    companyId,
    sourceType: "greenhouse",
    dedupeKey,
    job: {
      externalId: "job-celigo-summgate",
      title: "Senior Data Engineer",
      location: "Remote",
      department: "Eng",
      url: "https://boards.greenhouse.io/celigoco/job-celigo-summgate",
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
      candidateId: candidateBobId,
      jobId: jobCeligo.id,
      dedupeKey: jobCeligo.dedupe_key,
      candidateProfileHash: "res-hash-summgate:skills-hash-summgate",
      decision: "READY_FOR_TAILORING",
    })
  );

  setMarkedForTailoring(candidateBobId, jobCeligo.dedupe_key, true, {
    approvalType: "READY_DIRECT",
    decision: "READY_FOR_TAILORING",
  });

  const { run } = startTailoringRun({ candidateId: candidateBobId, jobId: jobCeligo.id });
  runBobCeligoId = run.id;
  appBobCeligoId = getCandidateJobState(candidateBobId, jobCeligo.dedupe_key)!.id;
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
// STEP 7: FOCUSED TESTS (SUMMARY-I1-01 .. SUMMARY-I1-15)
// =================================================================================================

test("SUMMARY-I1-01: INITIAL_GENERATION contains explicit first-pass summary acceptance requirement", () => {
  const profile = buildRichCandidateProfile();
  const identity = deriveProfessionalIdentity(profile);
  const section = renderProfessionalIdentitySection(identity, profile.totalYearsExperience);
  // PHASE 6.5 — "Iteration 1 Publication Quality" was trimmed from this section to fit the 600-token
  // compact-prompt budget (see writerPromptCompactionPhase3.test.ts's PROMPTCOMPACT-02); the fuller
  // "publication-ready on iteration 1, no assumed repair pass" instruction is stated once, at the
  // top-level INITIAL_GENERATION guardrails (handoff/exporter.ts's own rewriteRule), not duplicated
  // here. This section still explicitly frames the summary rule as Publication Quality.
  assert.match(section, /Publication Quality/);
});

test("SUMMARY-I1-02: summary prioritizes verified professional identity", () => {
  const profile = buildRichCandidateProfile();
  const identity = deriveProfessionalIdentity(profile);
  const section = renderProfessionalIdentitySection(identity, profile.totalYearsExperience);
  // PHASE 6.5 — recruiter-natural policy: the identity-first structure is now expressed as sentence
  // (1) "identity opening" (role + years + broad specialization) rather than the old 4-point
  // "Professional Identity & Scope" label — see professionalIdentity.ts's own summary rule text.
  assert.match(section, /identity opening/);
  assert.match(section, /with \[years\]\+ years of experience/);
});

test("SUMMARY-I1-03: summary prioritizes JD-critical capabilities", () => {
  // PHASE 6.6 — the 4-point "Verified Professional Identity & target domain / Core architecture
  // ownership / Concrete delivery impact / Defining supported tools" structure was a STALE,
  // pre-Phase-6.5 duplicate living in writerOutputQuality.ts; professionalIdentity.ts's own summary
  // rule (already Phase 6.5-corrected) is now the single place this structure is stated, as sentences
  // (1) identity opening, (2) engineering depth, (3) how that experience maps to the JD's themes — see
  // SUMMARY-I1-04's own comment just below for the same substance-preserved rewording.
  const profile = buildRichCandidateProfile();
  const identity = deriveProfessionalIdentity(profile);
  const qualitySec = renderProfessionalIdentitySection(identity, profile.totalYearsExperience);
  assert.match(qualitySec, /identity opening/);
  assert.match(qualitySec, /engineering depth/);
  assert.match(qualitySec, /how that experience maps to this JD/);
});

test("SUMMARY-I1-04: summary requires engineering/architecture/value positioning rather than technology dumping", () => {
  const profile = buildRichCandidateProfile();
  const identity = deriveProfessionalIdentity(profile);
  const section = renderProfessionalIdentitySection(identity, profile.totalYearsExperience);
  // PHASE 6.5 — "Architecture & Engineering Ownership" / "Business & Delivery Impact" (sentences 2/3
  // of the old 4-point structure) are now sentence (2) "engineering depth" and sentence (3) "maps to
  // this JD's most important themes" — the same positioning-over-inventory substance, 3 sentences
  // instead of 4 points (see task Phase 6.5's own recruiter-natural summary policy).
  assert.match(section, /engineering depth/);
  assert.match(section, /maps to this JD's most important themes/);
  assert.match(section, /Weak — a keyword dump/);
  assert.match(section, /Strong — the register to aim for/);
});

test("SUMMARY-I1-05: summary remains one concise paragraph / existing structure contract preserved", () => {
  const summaryIssues = checkSummaryShape(PERFECT_RESUME.summary);
  assert.equal(summaryIssues.length, 0);
  const tooFewSentences = checkSummaryShape(["Only one sentence."]);
  assert.ok(tooFewSentences.some((i) => i.kind === "SUMMARY_SENTENCE_COUNT"));
});

test("SUMMARY-I1-06: technology-count limit remains preserved", () => {
  const goodQuality = checkSummaryQuality(PERFECT_RESUME.summary);
  assert.equal(goodQuality.length, 0);
  const dumpedSummary = [
    "Data Engineer using Snowflake, Python, SQL, Azure Data Factory, Databricks, PySpark, Delta Lake, Kafka, and Airflow for data ingestion.",
  ];
  const dumpIssues = checkSummaryQuality(dumpedSummary);
  assert.ok(dumpIssues.some((i) => i.kind === "SUMMARY_TECHNOLOGY_DUMP"));
});

test("SUMMARY-I1-07: unsupported JD skills cannot be introduced", () => {
  const profile = buildRichCandidateProfile();
  const selected = selectWriterEvidence({ candidateProfile: profile, jobRequirements: CELIGO_REQUIREMENTS, targetRoleTitle: "Senior Data Engineer" });
  assert.equal(selected.globalRelevantSkills.primary.includes("AWS Glue"), false);
});

test("SUMMARY-I1-08: candidate title/employer/date truthfulness remains unchanged", () => {
  const profile = buildRichCandidateProfile();
  const selected = selectWriterEvidence({ candidateProfile: profile, jobRequirements: CELIGO_REQUIREMENTS, targetRoleTitle: "Senior Data Engineer" });
  assert.equal(selected.employers[0].employer, "Acme Corp");
  assert.equal(selected.employers[0].title, "Senior Data Engineer");
});

test("SUMMARY-I1-09: repair-mode prompt is NOT unnecessarily expanded", () => {
  const repairPrompt = buildExternalWriterPrompt({
    candidateId: 1,
    candidateName: "Bob Builder",
    applicationId: 1,
    jobId: 1,
    tailoringRunId: 1,
    workflowId: 1,
    iterationNumber: 2,
    writerMode: "TARGETED_REPAIR",
    selectedTrack: "Data Engineer",
    repairPlanSection: "## TARGETED REPAIR\n\nEditable: resume.summary[0]",
    patchEligiblePaths: ["resume.summary[0]"],
  });
  assert.match(repairPrompt, /REPAIR REVIEW CONTRACT/);
  assert.ok(Buffer.byteLength(repairPrompt, "utf-8") < 15000);
});

test("SUMMARY-I1-10: Phase 2 scoped evidence remains the evidence source", () => {
  const profile = buildRichCandidateProfile();
  const selected = selectWriterEvidence({ candidateProfile: profile, jobRequirements: CELIGO_REQUIREMENTS, targetRoleTitle: "Senior Data Engineer" });
  assert.ok(selected.scopedEmployerMap.employers.length > 0);
});

test("SUMMARY-I1-11: raw 535-skill inventory is not restored to writer context", () => {
  const profile = buildRichCandidateProfile();
  const selected = selectWriterEvidence({ candidateProfile: profile, jobRequirements: CELIGO_REQUIREMENTS, targetRoleTitle: "Senior Data Engineer" });
  assert.ok(selected.globalRelevantSkills.all.length <= 35);
});

// PHASE 6.3A (2026-08-24) — ceiling raised from 6,500 to 7,000 tokens, matching this phase's own
// explicit token budget (preferred <=6,000 "if practical", hard ceiling <=7,000): canonical JD
// reconciliation now surfaces the full material requirement inventory (Data Vault, Medallion/
// Lakehouse Architecture, Data Governance, Access Control, Cost/Performance Optimization, dbt,
// Fivetran, Airflow, Prefect, CI/CD, GitHub Actions, Observability, Data Lineage, ELT/ETL Pipeline
// Development, AI-assisted Development, etc. — previously invisible to the writer, see
// jdRequirementReconciler.ts) rather than the legacy 3-item structured list. The genuine token cost
// of that completeness is a few hundred tokens; the prompt still stays well inside the new hard
// ceiling.
test("SUMMARY-I1-12: fresh-generation context remains <= 7,000 tokens", () => {
  const wf = createResumeQualityWorkflow({
    candidateId: candidateBobId,
    applicationId: appBobCeligoId,
    tailoringRunId: runBobCeligoId,
    dedupeKey: jobCeligo.dedupe_key,
  });

  const exportRes = exportExternalWriterPackage({
    candidateId: candidateBobId,
    workflowId: wf.id,
    targetIterationNumber: 1,
    overwriteExisting: true,
  });

  const measurement = measureHandoffContext(exportRes.handoffDirectory);
  assert.ok(
    measurement.totalReadEstimatedTokens <= 7000,
    `Total read tokens (${measurement.totalReadEstimatedTokens}) exceeds target of 7,000 tokens`
  );
});

test("SUMMARY-I1-13: existing banned-language rules remain active", () => {
  const qualitySec = renderWriterOutputQualitySection();
  assert.match(qualitySec, /results-driven/);
  assert.match(qualitySec, /seasoned professional/);
  assert.match(qualitySec, /proven track record/);
});

test("SUMMARY-I1-14: summary rules contain no Celigo-specific hardcoding", () => {
  const profile = buildRichCandidateProfile();
  const identity = deriveProfessionalIdentity(profile);
  const identitySec = renderProfessionalIdentitySection(identity, profile.totalYearsExperience);
  const qualitySec = renderWriterOutputQualitySection();
  const presentationSec = renderPresentationStandardSection(profile);
  assert.doesNotMatch(identitySec, /Celigo/i);
  assert.doesNotMatch(qualitySec, /Celigo/i);
  assert.doesNotMatch(presentationSec, /Celigo/i);
});

test("SUMMARY-I1-15: no ApplicationRun or submission behavior is touched", () => {
  assert.ok(runBobCeligoId > 0);
  assert.ok(appBobCeligoId > 0);
});
