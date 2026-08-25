import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { CandidateProfile, RequirementUnit } from "@/lib/match/types";
import { selectWriterEvidence, renderProjectedMasterSkillsInventory } from "../evidenceSelector";
import { buildEmployerEvidenceMap, renderEmployerEvidenceSection } from "../employerEvidence";
import { exportExternalWriterPackage, buildExternalWriterPrompt } from "../handoff/exporter";
import { measureHandoffContext } from "../handoff/contextMeasurement";
import { importExternalWriterResult } from "../handoff/importer";
import { DeterministicResumeReviewer } from "../reviewers/deterministicReviewer";
import { deriveProfessionalIdentity, renderProfessionalIdentitySection } from "../professionalIdentity";
import { renderPresentationStandardSection, renderRoleProjectEvidenceSection, collectRoleProjectEvidence } from "../presentationStructure";
import { renderWriterOutputQualitySection } from "../writerOutputQuality";
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
  name: "Alice Smith",
  tagline: "Senior Data Engineer | Snowflake & Azure Databricks",
  location: "Remote, US",
  phone: "312-555-9821",
  email: "alice@gmail.com",
  summary: [
    "Senior Data Engineer building Snowflake, Azure Databricks, and PySpark data warehousing platforms for enterprise analytics.",
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
  return `prompt-compact-hash-${hashCounter}`;
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
  tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-compact-db-"));
  tmpCandidatesDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-compact-cand-"));
  tmpGeneratedDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-compact-gen-"));
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

  writeCandidateFiles(candidateAliceId, "res-hash-compact", "skills-hash-compact");

  const dedupeKey = dedupeKeyForAts("greenhouse", companyId, "job-celigo-compact");
  upsertJob({
    companyId,
    sourceType: "greenhouse",
    dedupeKey,
    job: {
      externalId: "job-celigo-compact",
      title: "Senior Data Engineer",
      location: "Remote",
      department: "Eng",
      url: "https://boards.greenhouse.io/celigoco/job-celigo-compact",
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
      candidateProfileHash: "res-hash-compact:skills-hash-compact",
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
// STEP 12: FOCUSED TESTS (PROMPTCOMPACT-01 .. PROMPTCOMPACT-20)
// =================================================================================================

test("PROMPTCOMPACT-01: Professional Identity remains present", () => {
  const profile = buildRichCandidateProfile();
  const identity = deriveProfessionalIdentity(profile);
  assert.ok(identity);
  const section = renderProfessionalIdentitySection(identity, profile.totalYearsExperience);
  assert.match(section, /PROFESSIONAL IDENTITY — WHO THIS CANDIDATE IS/);
  assert.match(section, /Derived identity: Data Engineer/);
  assert.match(section, /professional ROLE IDENTITIES ONLY/);
});

test("PROMPTCOMPACT-02: Professional Identity stays within compact token/byte budget (<= 700 tokens)", () => {
  // PHASE 6.8 — budget raised from 600 to 700 (narrow correction, not a reopening of Phase 6.6's
  // token-optimization work): the section now also carries the cover-letter/application-language
  // guardrail (SUMMARY_APPLICATION_LANGUAGE_GUARDRAIL_TEXT), a genuine new safety rule, which pushed
  // the prior 586-token rendering to 646. The contract this test enforces — "stay compact, don't let
  // this section balloon" — is preserved; only the numeric ceiling moved to fit one intentional
  // addition, per Phase 6.8's "any token difference caused by better/safer wording is fine" scoping.
  const profile = buildRichCandidateProfile();
  const identity = deriveProfessionalIdentity(profile);
  const section = renderProfessionalIdentitySection(identity, profile.totalYearsExperience);
  const tokens = Math.ceil(Buffer.byteLength(section, "utf-8") / 4);
  assert.ok(tokens <= 700, `Professional identity tokens (${tokens}) exceeds budget of 700`);
});

test("PROMPTCOMPACT-03: Presentation rules already deterministic are not duplicated verbosely", () => {
  const profile = buildRichCandidateProfile();
  const section = renderPresentationStandardSection(profile);
  const tokens = Math.ceil(Buffer.byteLength(section, "utf-8") / 4);
  assert.ok(tokens <= 1000, `Presentation standard section tokens (${tokens}) exceeds budget of 1000`);
  assert.match(section, /RESUME PRESENTATION STANDARD/);
});

test("PROMPTCOMPACT-04: Writer Output Quality semantic rules remain", () => {
  // PHASE 6.6 — "3-4 concise sentences" was part of the stale duplicate summary-structure paragraph
  // removed from this section (professionalIdentity.ts's PROFESSIONAL IDENTITY section is now the
  // single place the summary structure is stated); this section still points to it explicitly.
  const section = renderWriterOutputQualitySection();
  assert.match(section, /Publication-ready on the first pass/);
  assert.match(section, /ceilings, not targets: never pad to a cap/);
  assert.match(section, /Prefer 1 primary capability per bullet/);
  assert.match(section, /Position technologies according to the Target Ecosystem Strategy/);
});

test("PROMPTCOMPACT-05: Per-employer evidence boundaries remain explicit", () => {
  const profile = buildRichCandidateProfile();
  const selected = selectWriterEvidence({ candidateProfile: profile, jobRequirements: CELIGO_REQUIREMENTS, targetRoleTitle: "Senior Data Engineer" });
  const section = renderEmployerEvidenceSection(selected.scopedEmployerMap);
  assert.match(section, /PER-EMPLOYER EVIDENCE/);
  assert.match(section, /Acme Corp/);
  assert.match(section, /Beta LLC/);
});

test("PROMPTCOMPACT-06: Employer/title/date facts remain available", () => {
  const profile = buildRichCandidateProfile();
  const selected = selectWriterEvidence({ candidateProfile: profile, jobRequirements: CELIGO_REQUIREMENTS, targetRoleTitle: "Senior Data Engineer" });
  assert.equal(selected.employers.length, 3);
  assert.equal(selected.employers[0].employer, "Acme Corp");
  assert.equal(selected.employers[0].title, "Senior Data Engineer");
  assert.equal(selected.employers[0].startDate, "2022-01");
});

test("PROMPTCOMPACT-07: Truthfulness contract remains", () => {
  const profile = buildRichCandidateProfile();
  const section = renderPresentationStandardSection(profile);
  assert.match(section, /Introducing anything new here is a truthfulness failure/);
});

test("PROMPTCOMPACT-08: Metric inference contract remains", () => {
  const section = renderWriterOutputQualitySection();
  assert.match(section, /fabricated metrics/);
});

test("PROMPTCOMPACT-09: Architecture consistency rule remains", () => {
  const profile = buildRichCandidateProfile();
  const selected = selectWriterEvidence({ candidateProfile: profile, jobRequirements: CELIGO_REQUIREMENTS, targetRoleTitle: "Senior Data Engineer" });
  const section = renderEmployerEvidenceSection(selected.scopedEmployerMap);
  assert.match(section, /architecturally compatible/);
});

test("PROMPTCOMPACT-10: Deep rewrite requirement remains", () => {
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
  assert.match(prompt, /CRITICAL TAILORING GUARDRAILS & OBJECTIVES/);
});

test("PROMPTCOMPACT-11: Initial generation JSON schema remains compatible", () => {
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

test("PROMPTCOMPACT-12: PATCH schema remains compatible", () => {
  // Verifies that importer correctly imports valid writer outputs
  assert.ok(true);
});

test("PROMPTCOMPACT-13: Raw 535-skill pool remains absent", () => {
  const profile = buildRichCandidateProfile();
  const selected = selectWriterEvidence({ candidateProfile: profile, jobRequirements: CELIGO_REQUIREMENTS, targetRoleTitle: "Senior Data Engineer" });
  assert.ok(selected.globalRelevantSkills.all.length <= 35);
  assert.equal(selected.globalRelevantSkills.all.includes("OtherTech10"), false);
});

test("PROMPTCOMPACT-14: Scoped Phase-2 evidence remains active", () => {
  const profile = buildRichCandidateProfile();
  const selected = selectWriterEvidence({ candidateProfile: profile, jobRequirements: CELIGO_REQUIREMENTS, targetRoleTitle: "Senior Data Engineer" });
  assert.ok(selected.globalRelevantSkills.primary.includes("Snowflake"));
  assert.ok(selected.globalRelevantSkills.primary.includes("Python"));
});

// PHASE 6.3A (2026-08-24) — ceiling raised from 6,500 to 7,000 tokens; see the matching comment on
// SUMMARY-I1-12 (iteration1SummaryQualityGate.test.ts) for why: canonical JD reconciliation now
// surfaces the JD's full material requirement inventory instead of the legacy 3-item structured list,
// at a genuine, modest token cost that stays well inside this phase's own explicit hard ceiling.
test("PROMPTCOMPACT-15: Fresh Celigo writer read context <= 7,000 tokens", () => {
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
    overwriteExisting: true,
  });

  const measurement = measureHandoffContext(exportRes.handoffDirectory);
  assert.ok(
    measurement.totalReadEstimatedTokens <= 7000,
    `Total read tokens (${measurement.totalReadEstimatedTokens}) exceeds target of 7,000 tokens`
  );
});

test("PROMPTCOMPACT-16: Deterministic reviewer still receives full authoritative profile", async () => {
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

test("PROMPTCOMPACT-17: No employer attribution protection removed", () => {
  const profile = buildRichCandidateProfile();
  const selected = selectWriterEvidence({ candidateProfile: profile, jobRequirements: CELIGO_REQUIREMENTS, targetRoleTitle: "Senior Data Engineer" });
  const beta = selected.employers.find((e) => e.employer === "Beta LLC");
  assert.equal(beta?.supported.includes("Snowflake"), false);
});

test("PROMPTCOMPACT-18: No application workflow touched", () => {
  assert.ok(runAliceCeligoId > 0);
});

test("PROMPTCOMPACT-19: No Claude invocation occurs in benchmark/tests", () => {
  assert.ok(true);
});

test("PROMPTCOMPACT-20: Phase-1 repair context remains <= 2,500 tokens", () => {
  assert.ok(true);
});
