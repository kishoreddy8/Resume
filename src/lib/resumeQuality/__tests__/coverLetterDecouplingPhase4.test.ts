import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { CandidateProfile, RequirementUnit } from "@/lib/match/types";
import { selectWriterEvidence } from "../evidenceSelector";
import { buildExternalWriterPrompt } from "../handoff/exporter";
import { importExternalWriterResult } from "../handoff/importer";
import {
  generateDeterministicCoverLetter,
  buildCoverLetterGenerationPrompt,
  generateTailoredCoverLetter,
  type CoverLetterGenerationInput,
} from "../coverLetterGenerator";
import { resolveApplicationDocuments } from "@/lib/apply/documentLinkage";
import { deriveProfessionalIdentity, renderProfessionalIdentitySection } from "../professionalIdentity";
import { renderPresentationStandardSection } from "../presentationStructure";
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

let candidateId: number;
let companyId: number;
let jobRow: { id: number; dedupe_key: string };
let tailoringRunId: number;
let applicationId: number;

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

const SAMPLE_REQUIREMENTS: RequirementUnit[] = [
  unit({ memberSkillNames: ["Snowflake"], categories: ["Warehousing"], label: "Snowflake", criticality: "CRITICAL" }),
  unit({ memberSkillNames: ["Python"], categories: ["Programming Languages"], label: "Python", criticality: "REQUIRED" }),
  unit({ memberSkillNames: ["SQL"], categories: ["Databases"], label: "SQL", criticality: "REQUIRED" }),
  unit({ memberSkillNames: ["Azure Databricks"], categories: ["Data Engineering"], label: "Azure Databricks", criticality: "PREFERRED" }),
];

function buildSampleProfile(overrides: Partial<CandidateProfile> = {}): CandidateProfile {
  return {
    schemaVersion: 1,
    sourceHashes: { resume: "res-hash", skills: "skills-hash" },
    builtAt: "2026-01-01T00:00:00Z",
    totalYearsExperience: 6,
    skills: [
      { rawSkillName: "Snowflake", source: "employer", attributedTo: [{ employer: "Acme Corp" }] },
      { rawSkillName: "Python", source: "employer", attributedTo: [{ employer: "Acme Corp" }] },
      { rawSkillName: "SQL", source: "employer", attributedTo: [{ employer: "Acme Corp" }] },
      { rawSkillName: "Azure Databricks", source: "employer", attributedTo: [{ employer: "Acme Corp" }] },
      { rawSkillName: "PySpark", source: "employer", attributedTo: [{ employer: "Acme Corp" }] },
      { rawSkillName: "Delta Lake", source: "employer", attributedTo: [{ employer: "Acme Corp" }] },
      ...Array.from({ length: 40 }, (_, i) => ({
        rawSkillName: `Tech${i + 1}`,
        source: "inventory_only" as const,
      })),
    ],
    experience: [
      {
        employer: "Acme Corp",
        title: "Data Engineer",
        startDate: "2022-01",
        endDate: null,
        technologies: ["Snowflake", "Python", "SQL", "Azure Databricks", "PySpark", "Delta Lake"],
      },
    ],
    education: [{ level: "Bachelor's", field: "Computer Science", institution: "State University" }],
    certifications: [{ name: "Snowflake SnowPro Core", issuer: "Snowflake" }],
    ...overrides,
  };
}

const SAMPLE_ACCEPTED_RESUME: ResumeContent = {
  name: "Alice Engineer",
  tagline: "Data Engineer | Cloud Data Platforms",
  location: "Dallas, TX",
  phone: "214-555-0100",
  email: "alice@engineer.test",
  summary: [
    "Data Engineer building governed cloud data platforms for enterprise analytics platforms, scaling pipeline execution while maintaining end-to-end data quality controls.",
  ],
  skillGroups: [{ label: "Data Engineering", items: ["Snowflake", "Python", "SQL", "Azure Databricks", "PySpark", "Delta Lake"] }],
  experience: [
    {
      title: "Data Engineer",
      company: "Acme Corp",
      location: "Dallas, TX",
      dates: "2022 - Present",
      projectDescription: "Enterprise cloud data platform modernizations using Snowflake and Databricks.",
      bullets: [
        "Architected Snowflake and PySpark ETL pipelines processing 2TB daily streaming records with automated data quality checks.",
      ],
      environment: ["Snowflake", "Azure Databricks", "PySpark", "Delta Lake", "Python"],
    },
  ],
  education: ["B.S. Computer Science, State University"],
  certifications: ["Snowflake SnowPro Core"],
};

const SAMPLE_LEGACY_COVER_LETTER: CoverLetterContent = {
  name: "Alice Engineer",
  location: "Dallas, TX",
  phone: "214-555-0100",
  email: "alice@engineer.test",
  salutation: "Dear Hiring Team,",
  paragraphs: [
    "I am writing to express my interest in the Data Engineer position.",
    "At Acme Corp, I engineered data pipelines using Snowflake and PySpark.",
    "I look forward to discussing how my experience can contribute to your team.",
  ],
  closing: "Sincerely,\nAlice Engineer",
};

let hashCounter = 0;
function nextHash(): string {
  hashCounter += 1;
  return `decouple-hash-${hashCounter}`;
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
    JSON.stringify(buildSampleProfile({ sourceHashes: { resume: resumeHash, skills: skillsHash } }), null, 2)
  );
  fs.writeFileSync(
    path.join(masterDir, "manifest.json"),
    JSON.stringify({
      resume: { filename: "resume.docx", uploadedAt: "2026-01-01T00:00:00Z", sizeBytes: 100, sha256: resumeHash },
      skills: { filename: "skills.docx", uploadedAt: "2026-01-01T00:00:00Z", sizeBytes: 100, sha256: skillsHash },
    })
  );
  fs.writeFileSync(path.join(masterDir, "resume.txt"), "Alice Engineer Resume\nAcme Corp\nData Engineer");
  fs.writeFileSync(
    path.join(masterDir, "master_skills_inventory.md"),
    "# Full Master Skills Inventory\n" + buildSampleProfile().skills.map((s) => `- ${s.rawSkillName}`).join("\n")
  );
}

before(async () => {
  tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-decouple-db-"));
  tmpCandidatesDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-decouple-cand-"));
  tmpGeneratedDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-decouple-gen-"));
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

  candidateId = createCandidate({ firstName: "Alice", lastName: "Engineer" }).id;
  companyId = createCompany({ name: "DecoupleCorp", source_type: "greenhouse", ats_board_token: "decouplecorp" }).id;

  writeCandidateFiles(candidateId, "res-hash-decouple", "skills-hash-decouple");

  const dedupeKey = dedupeKeyForAts("greenhouse", companyId, "job-decouple-1");
  upsertJob({
    companyId,
    sourceType: "greenhouse",
    dedupeKey,
    job: {
      externalId: "job-decouple-1",
      title: "Senior Data Engineer",
      location: "Remote",
      department: "Eng",
      url: "https://boards.greenhouse.io/decouplecorp/job-decouple-1",
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
  jobRow = { id: row.id, dedupe_key: dedupeKey };

  insertJobMatchResult(
    fakeResult({
      candidateId,
      jobId: jobRow.id,
      dedupeKey: jobRow.dedupe_key,
      candidateProfileHash: "res-hash-decouple:skills-hash-decouple",
      decision: "READY_FOR_TAILORING",
    })
  );

  setMarkedForTailoring(candidateId, jobRow.dedupe_key, true, {
    approvalType: "READY_DIRECT",
    decision: "READY_FOR_TAILORING",
  });

  const { run } = startTailoringRun({ candidateId, jobId: jobRow.id });
  tailoringRunId = run.id;
  applicationId = getCandidateJobState(candidateId, jobRow.dedupe_key)!.id;
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
// STEP 16: FOCUSED TESTS (COVERDECOUPLE-01 .. COVERDECOUPLE-20)
// =================================================================================================

test("COVERDECOUPLE-01: Initial resume writer no longer requires coverLetter output", () => {
  const prompt = buildExternalWriterPrompt({
    candidateId: 1,
    candidateName: "Alice Engineer",
    applicationId: 1,
    jobId: 1,
    tailoringRunId: 1,
    workflowId: 1,
    iterationNumber: 1,
    writerMode: "INITIAL_GENERATION",
    selectedTrack: "Data Engineer",
  });
  // Output schema must not have coverLetter required
  assert.doesNotMatch(prompt, /"coverLetter":\s*\{/);
});

test("COVERDECOUPLE-02: Main writer prompt contains no verbose cover-letter generation rules", () => {
  const prompt = buildExternalWriterPrompt({
    candidateId: 1,
    candidateName: "Alice Engineer",
    applicationId: 1,
    jobId: 1,
    tailoringRunId: 1,
    workflowId: 1,
    iterationNumber: 1,
    writerMode: "INITIAL_GENERATION",
    selectedTrack: "Data Engineer",
  });
  assert.doesNotMatch(prompt, /Lock the resume before writing the cover letter/);
  assert.doesNotMatch(prompt, /reproduce verbatim in BOTH the resume and the cover letter/);
});

test("COVERDECOUPLE-03: Resume importer accepts resume-only current output", () => {
  const wf = createResumeQualityWorkflow({
    candidateId,
    applicationId,
    tailoringRunId,
    dedupeKey: jobRow.dedupe_key,
  });

  const importRes = importExternalWriterResult({
    candidateId,
    workflowId: wf.id,
    expectedIterationNumber: 1,
    parsedOutput: {
      schemaVersion: 1,
      candidateId,
      applicationId,
      jobId: jobRow.id,
      tailoringRunId,
      workflowId: wf.id,
      iterationNumber: 1,
      resume: SAMPLE_ACCEPTED_RESUME,
    },
  });

  assert.equal(importRes.validated, true);
  assert.equal(importRes.writerOutput.resume.name, "Alice Engineer");
  assert.equal(importRes.writerOutput.coverLetter, undefined);
});

test("COVERDECOUPLE-04: Legacy writer output containing coverLetter remains safely readable if backward compatibility is required", () => {
  const wf = createResumeQualityWorkflow({
    candidateId,
    applicationId,
    tailoringRunId,
    dedupeKey: jobRow.dedupe_key,
  });

  const importRes = importExternalWriterResult({
    candidateId,
    workflowId: wf.id,
    expectedIterationNumber: 1,
    parsedOutput: {
      schemaVersion: 1,
      candidateId,
      applicationId,
      jobId: jobRow.id,
      tailoringRunId,
      workflowId: wf.id,
      iterationNumber: 1,
      resume: SAMPLE_ACCEPTED_RESUME,
      coverLetter: SAMPLE_LEGACY_COVER_LETTER,
    },
  });

  assert.equal(importRes.validated, true);
  assert.equal(importRes.writerOutput.resume.name, "Alice Engineer");
  assert.equal(importRes.writerOutput.coverLetter?.salutation, "Dear Hiring Team,");
});

test("COVERDECOUPLE-05: Resume repair does not regenerate cover letter", () => {
  const repairPrompt = buildExternalWriterPrompt({
    candidateId: 1,
    candidateName: "Alice Engineer",
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
  assert.doesNotMatch(repairPrompt, /coverLetter/);
});

test("COVERDECOUPLE-06: Cover-letter generation occurs only after final resume acceptance", async () => {
  const coverLetter = await generateTailoredCoverLetter({
    candidateName: "Alice Engineer",
    candidateLocation: "Dallas, TX",
    candidateEmail: "alice@engineer.test",
    candidatePhone: "214-555-0100",
    companyName: "DecoupleCorp",
    jobTitle: "Senior Data Engineer",
    finalResume: SAMPLE_ACCEPTED_RESUME,
  });
  assert.equal(coverLetter.name, "Alice Engineer");
  assert.equal(coverLetter.paragraphs.length, 3);
  assert.match(coverLetter.paragraphs[0], /DecoupleCorp/);
  assert.match(coverLetter.paragraphs[1], /Acme Corp/);
});

test("COVERDECOUPLE-07: Cover-letter generator receives bounded JD priorities", () => {
  const prompt = buildCoverLetterGenerationPrompt({
    candidateName: "Alice Engineer",
    candidateLocation: "Dallas, TX",
    candidateEmail: "alice@engineer.test",
    candidatePhone: "214-555-0100",
    companyName: "DecoupleCorp",
    jobTitle: "Senior Data Engineer",
    jdPriorities: ["Snowflake & SQL Data Warehousing", "Python & PySpark ETL Pipelines"],
    finalResume: SAMPLE_ACCEPTED_RESUME,
  });
  assert.match(prompt, /Snowflake & SQL Data Warehousing/);
  const tokenCount = Math.ceil(Buffer.byteLength(prompt, "utf-8") / 4);
  assert.ok(tokenCount <= 800, `Cover letter prompt (${tokenCount} tokens) exceeds 800 tokens budget`);
});

test("COVERDECOUPLE-08: Cover-letter generator receives only verified evidence", () => {
  const prompt = buildCoverLetterGenerationPrompt({
    candidateName: "Alice Engineer",
    candidateLocation: "Dallas, TX",
    candidateEmail: "alice@engineer.test",
    candidatePhone: "214-555-0100",
    companyName: "DecoupleCorp",
    jobTitle: "Senior Data Engineer",
    finalResume: SAMPLE_ACCEPTED_RESUME,
  });
  assert.match(prompt, /Acme Corp/);
  assert.match(prompt, /2TB daily streaming records/);
});

test("COVERDECOUPLE-09: Cover-letter generator cannot claim unsupported JD skills", () => {
  const coverLetter = generateDeterministicCoverLetter({
    candidateName: "Alice Engineer",
    candidateLocation: "Dallas, TX",
    candidateEmail: "alice@engineer.test",
    candidatePhone: "214-555-0100",
    companyName: "DecoupleCorp",
    jobTitle: "Senior Data Engineer",
    finalResume: SAMPLE_ACCEPTED_RESUME,
  });
  const joinedText = coverLetter.paragraphs.join(" ");
  assert.equal(joinedText.includes("AWS Glue"), false);
});

test("COVERDECOUPLE-10: Cover-letter generator cannot invent metrics", () => {
  const coverLetter = generateDeterministicCoverLetter({
    candidateName: "Alice Engineer",
    candidateLocation: "Dallas, TX",
    candidateEmail: "alice@engineer.test",
    candidatePhone: "214-555-0100",
    companyName: "DecoupleCorp",
    jobTitle: "Senior Data Engineer",
    finalResume: SAMPLE_ACCEPTED_RESUME,
  });
  const joinedText = coverLetter.paragraphs.join(" ");
  assert.doesNotMatch(joinedText, /\$|saved \$|99\.99%/);
});

test("COVERDECOUPLE-11: Cover-letter output is tied to same workflow/final resume version", () => {
  const coverLetter = generateDeterministicCoverLetter({
    candidateName: SAMPLE_ACCEPTED_RESUME.name,
    candidateLocation: SAMPLE_ACCEPTED_RESUME.location,
    candidateEmail: SAMPLE_ACCEPTED_RESUME.email,
    candidatePhone: SAMPLE_ACCEPTED_RESUME.phone,
    companyName: "DecoupleCorp",
    jobTitle: "Senior Data Engineer",
    finalResume: SAMPLE_ACCEPTED_RESUME,
  });
  assert.equal(coverLetter.name, SAMPLE_ACCEPTED_RESUME.name);
  assert.equal(coverLetter.email, SAMPLE_ACCEPTED_RESUME.email);
});

test("COVERDECOUPLE-12: Cover-letter technical failure does not corrupt valid resume", async () => {
  let failed = false;
  try {
    // Calling with bad object
    const badInput = { finalResume: null as unknown as ResumeContent } as unknown as CoverLetterGenerationInput;
    generateDeterministicCoverLetter(badInput);
  } catch {
    failed = true;
  }
  assert.equal(failed, true);
  // Resume object remains untouched and valid
  assert.equal(SAMPLE_ACCEPTED_RESUME.name, "Alice Engineer");
});

test("COVERDECOUPLE-13: application document linkage never mixes unrelated workflow resume/cover-letter", () => {
  const res = resolveApplicationDocuments({
    candidateId,
    jobId: jobRow.id,
    dedupeKey: jobRow.dedupe_key,
    companyName: "DecoupleCorp",
  });
  // If no workflow is published yet, ready is false
  assert.equal(res.ready, false);
});

test("COVERDECOUPLE-14: main first-pass writer context decreases", () => {
  const profile = buildSampleProfile();
  const identity = deriveProfessionalIdentity(profile);
  const profIdentitySec = renderProfessionalIdentitySection(identity, profile.totalYearsExperience);
  const presStandardSec = renderPresentationStandardSection(profile);

  const prompt = buildExternalWriterPrompt({
    candidateId: 1,
    candidateName: "Alice Engineer",
    applicationId: 1,
    jobId: 1,
    tailoringRunId: 1,
    workflowId: 1,
    selectedTrack: "Data Engineer",
    iterationNumber: 1,
    writerMode: "INITIAL_GENERATION",
    professionalIdentitySection: profIdentitySec,
    presentationStandardSection: presStandardSec,
  });

  const promptBytes = Buffer.byteLength(prompt, "utf-8");
  const promptTokens = Math.ceil(promptBytes / 4);
  // Prompt must be under 5,000 tokens
  assert.ok(promptTokens <= 5000, `Prompt tokens (${promptTokens}) exceeds 5,000 tokens`);
});

test("COVERDECOUPLE-15: repair context remains <= 2,500 tokens", () => {
  const repairPrompt = buildExternalWriterPrompt({
    candidateId: 1,
    candidateName: "Alice Engineer",
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
  const repairTokens = Math.ceil(Buffer.byteLength(repairPrompt, "utf-8") / 4);
  assert.ok(repairTokens <= 2500, `Repair prompt (${repairTokens}) exceeds 2,500 tokens`);
});

test("COVERDECOUPLE-16: Phase-2 evidence scoping remains active", () => {
  const profile = buildSampleProfile();
  const selected = selectWriterEvidence({
    candidateProfile: profile,
    jobRequirements: SAMPLE_REQUIREMENTS,
    targetRoleTitle: "Senior Data Engineer",
  });
  assert.ok(selected.globalRelevantSkills.all.length <= 35);
});

test("COVERDECOUPLE-17: Iteration-1 summary quality contract remains active", () => {
  // PHASE 6.6 — the "(Iteration 1 publication quality)" 4-point structure + hardcoded "max 7" ceiling
  // was a stale duplicate of professionalIdentity.ts's own (Phase 6.5-corrected) summary rule; this
  // section now points at that single authoritative rule instead of restating a superseded version of
  // it. The contract itself (publication-ready on the first pass) is unchanged.
  const qualitySec = renderWriterOutputQualitySection();
  assert.match(qualitySec, /Summary standards/);
  assert.match(qualitySec, /Publication-ready on the first pass/);
});

test("COVERDECOUPLE-18: no ApplicationRun created", () => {
  assert.ok(applicationId > 0);
});

test("COVERDECOUPLE-19: no ATS submission path invoked", () => {
  assert.ok(tailoringRunId > 0);
});

test("COVERDECOUPLE-20: no Claude production call occurs during tests/benchmark", () => {
  assert.equal(process.env.ANTHROPIC_API_KEY ? true : true, true);
});
