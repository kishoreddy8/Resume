/**
 * Phase 9A — real-corpus acceptance for final approved application-artifact publication.
 *
 * READ-MOSTLY DIAGNOSTIC TOOLING. Not application code, never imported by src/, never part of any
 * production code path. Against the database it is strictly read-only: it issues SELECTs and two
 * PRAGMA integrity reads, and it writes no table, ever. Its ONLY side effect is the one it exists to
 * prove — calling the existing publication module, which copies already-approved bytes from a READY
 * workflow's own final/ directory into data/generated/applications/. It re-implements nothing:
 * every path, filename, slug, and manifest field comes from src/lib/resumeQuality/finalPublication.ts.
 *
 * What it deliberately refuses to do:
 *   - create, approve, or authorize a tailoring run
 *   - regenerate resume or cover-letter content
 *   - run matching, scoring, ranking, or evaluation
 *   - call any AI provider, paid or otherwise (it makes no network calls at all)
 *   - submit an application anywhere
 *   - bypass the READY gate inside the publication module (it passes the workflow's real status)
 *   - fabricate a workflow, a job, or an artifact when the real corpus has none
 *
 * Safe to run repeatedly: republishing a READY workflow writes the same bytes to the same place
 * through the module's own atomic staged swap.
 *
 * Usage, from the repository root on the Mac that holds the real data/app.db:
 *     npx tsx tools/acceptance/phase9a-final-publication-acceptance.ts
 *
 * Exits 0 only if every invariant holds; non-zero otherwise.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDb, getDbPath } from "../../src/db";
import { getCandidate } from "../../src/db/queries/candidates";
import { getCompany } from "../../src/db/queries/companies";
import { getJobByDedupeKey } from "../../src/db/queries/jobs";
import { getTailoringRun } from "../../src/db/queries/tailoringRuns";
import {
  listResumeQualityIterations,
  type ResumeQualityWorkflowRow,
} from "../../src/db/queries/resumeQualityWorkflows";
import { getGeneratedRoot } from "../../src/lib/generatedFiles";
import { INSTRUCTION_HASH, INSTRUCTION_VERSION } from "../../src/lib/resumeQuality/canonicalInstructions";
import {
  publishFinalApplicationArtifacts,
  resolvePublishedApplicationTarget,
  type PublishedApplication,
} from "../../src/lib/resumeQuality/finalPublication";
import {
  finalCoverLetterFilename,
  finalResumeFilename,
  getFinalDirectory,
  type QualityWorkflowLocation,
} from "../../src/lib/resumeQuality/workspace";

const CANDIDATE_ID = 1;
/** The workflow Stage 25C called out. Preferred when it is still present and READY; the harness
 *  falls back to another READY workflow rather than failing, and says which it chose and why. */
const PREFERRED = { companyNameContains: "celigo", jobId: 7362 };

// ================================================================================================
// Pure, testable logic. Everything below this block is I/O and orchestration.
// ================================================================================================

export interface AcceptanceWorkflowCandidate {
  workflowId: number;
  candidateId: number;
  tailoringRunId: number;
  dedupeKey: string;
  status: string;
  finalApprovedIteration: number | null;
  currentIteration: number;
  jobId: number | null;
  jobTitle: string | null;
  companyId: number | null;
  companyName: string | null;
}

export interface AcceptanceSelection {
  selected: AcceptanceWorkflowCandidate;
  reason: "preferred" | "deterministic-fallback";
}

/**
 * Chooses the workflow to prove against. Only READY workflows are ever eligible — a workflow in any
 * other state has, by definition, nothing approved to publish. The preferred Stage 25C workflow wins
 * when it is present; otherwise the highest workflow id wins, which is both deterministic (the same
 * corpus always yields the same choice, so two runs are comparable) and the most recently approved.
 * Returns null rather than inventing a workflow when the corpus holds no READY one.
 */
export function selectAcceptanceWorkflow(
  workflows: AcceptanceWorkflowCandidate[],
  preferred: { companyNameContains: string; jobId: number } = PREFERRED
): AcceptanceSelection | null {
  const ready = workflows.filter((w) => w.status === "READY");
  if (ready.length === 0) return null;

  const wanted = ready.find(
    (w) =>
      w.jobId === preferred.jobId &&
      (w.companyName ?? "").toLowerCase().includes(preferred.companyNameContains.toLowerCase())
  );
  if (wanted) return { selected: wanted, reason: "preferred" };

  const fallback = [...ready].sort((a, b) => b.workflowId - a.workflowId)[0];
  return { selected: fallback, reason: "deterministic-fallback" };
}

export interface ExpectedManifestIdentity {
  candidateId: number;
  candidateName: string;
  companyId: number;
  companyName: string;
  jobId: number;
  jobTitle: string;
  tailoringRunId: number;
  workflowId: number;
  iterationId: number;
  workflowStatus: string;
  qualityGateOutcome: string;
  resumeSha256: string;
  coverLetterSha256: string | null;
}

/** Returns one human-readable message per mismatch; an empty array means the manifest correctly
 *  identifies the candidate, company, job, run, workflow, and approved iteration it came from. */
export function verifyManifestIdentity(manifest: unknown, expected: ExpectedManifestIdentity): string[] {
  const failures: string[] = [];
  if (typeof manifest !== "object" || manifest === null) {
    return ["manifest.json did not parse into an object"];
  }
  const m = manifest as Record<string, unknown>;

  const check = (field: string, actual: unknown, want: unknown) => {
    if (actual !== want) failures.push(`manifest.${field}: expected ${JSON.stringify(want)}, got ${JSON.stringify(actual)}`);
  };

  check("candidateId", m.candidateId, expected.candidateId);
  check("candidateName", m.candidateName, expected.candidateName);
  check("companyId", m.companyId, expected.companyId);
  check("companyName", m.companyName, expected.companyName);
  check("jobId", m.jobId, expected.jobId);
  check("jobTitle", m.jobTitle, expected.jobTitle);
  check("tailoringRunId", m.tailoringRunId, expected.tailoringRunId);
  check("workflowId", m.workflowId, expected.workflowId);
  check("iterationId", m.iterationId, expected.iterationId);
  check("workflowStatus", m.workflowStatus, expected.workflowStatus);
  check("qualityGateOutcome", m.qualityGateOutcome, expected.qualityGateOutcome);

  const checksums = m.checksums as Record<string, unknown> | undefined;
  if (!checksums) {
    failures.push("manifest.checksums is missing");
  } else {
    check("checksums.resume", checksums.resume, expected.resumeSha256);
    check("checksums.coverLetter", checksums.coverLetter, expected.coverLetterSha256);
  }

  const files = m.files as Record<string, unknown> | undefined;
  if (!files || typeof files.resume !== "string" || files.resume.length === 0) {
    failures.push("manifest.files.resume is missing or empty");
  }
  return failures;
}

/** Keys that must never appear in a manifest. Checked case-insensitively against the raw JSON text,
 *  so a value carrying one is caught as well as a key. */
const FORBIDDEN_MANIFEST_SUBSTRINGS = ["apikey", "api_key", "secret", "password", "bearer", "authorization"];

export function findForbiddenManifestContent(rawManifestJson: string): string[] {
  const haystack = rawManifestJson.toLowerCase();
  return FORBIDDEN_MANIFEST_SUBSTRINGS.filter((needle) => haystack.includes(needle));
}

export interface FileSnapshot {
  relPath: string;
  sha256: string;
  size: number;
  mtimeMs: number;
}

/** Byte-level AND mtime-level comparison of two directory snapshots. Anything added, removed,
 *  rewritten, or merely touched shows up here. */
export function diffSnapshots(before: FileSnapshot[], after: FileSnapshot[]): string[] {
  const failures: string[] = [];
  const beforeByPath = new Map(before.map((f) => [f.relPath, f]));
  const afterByPath = new Map(after.map((f) => [f.relPath, f]));

  for (const [relPath, b] of beforeByPath) {
    const a = afterByPath.get(relPath);
    if (!a) {
      failures.push(`${relPath}: file disappeared`);
      continue;
    }
    if (a.sha256 !== b.sha256) failures.push(`${relPath}: bytes changed (${b.sha256} -> ${a.sha256})`);
    if (a.mtimeMs !== b.mtimeMs) failures.push(`${relPath}: mtime changed (${b.mtimeMs} -> ${a.mtimeMs})`);
  }
  for (const relPath of afterByPath.keys()) {
    if (!beforeByPath.has(relPath)) failures.push(`${relPath}: new file appeared`);
  }
  return failures;
}

export interface TableCount {
  table: string;
  rows: number;
}

/** Any table whose row count moved is a production mutation this harness caused. */
export function diffTableCounts(before: TableCount[], after: TableCount[]): string[] {
  const beforeByTable = new Map(before.map((t) => [t.table, t.rows]));
  const failures: string[] = [];
  for (const { table, rows } of after) {
    const was = beforeByTable.get(table);
    if (was === undefined) {
      failures.push(`${table}: table appeared during the run`);
    } else if (was !== rows) {
      failures.push(`${table}: row count changed ${was} -> ${rows}`);
    }
  }
  for (const { table } of before) {
    if (!after.some((t) => t.table === table)) failures.push(`${table}: table disappeared during the run`);
  }
  return failures;
}

// ================================================================================================
// I/O helpers
// ================================================================================================

function sha256(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function snapshotDirectory(root: string): FileSnapshot[] {
  if (!fs.existsSync(root)) return [];
  const out: FileSnapshot[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const stat = fs.statSync(full);
        out.push({ relPath: path.relative(root, full), sha256: sha256(full), size: stat.size, mtimeMs: stat.mtimeMs });
      }
    }
  };
  walk(root);
  return out;
}

const failures: string[] = [];
const rule = () => console.log("=".repeat(96));

function record(label: string, ok: boolean, detail = ""): boolean {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
  return ok;
}

/** Preconditions abort the run outright: nothing after them can be verified, and a partial report
 *  would read as a weaker pass than it is. */
function abort(message: string): never {
  console.error(`\nABORT: ${message}\n`);
  console.error("PHASE 9A REAL-CORPUS ACCEPTANCE FAILED");
  process.exit(2);
}

// ================================================================================================
// Driver
// ================================================================================================

export function runAcceptance(): number {
  rule();
  console.log("PHASE 9A — REAL-CORPUS FINAL PUBLICATION ACCEPTANCE");
  rule();

  // --- Phase 0: environment ---------------------------------------------------------------------
  console.log("\nPHASE 0 — ENVIRONMENT");
  if (os.platform() !== "darwin") {
    abort(`this harness must run on macOS against the real corpus (os.platform() = "${os.platform()}", expected "darwin")`);
  }
  record("platform is Darwin/macOS", true, os.platform());

  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) abort(`database not found at ${dbPath}`);
  record("data/app.db exists", true, dbPath);

  const db = getDb();
  const one = <T>(sql: string, ...params: unknown[]): T => db.prepare(sql).get(...params) as T;
  const all = <T>(sql: string, ...params: unknown[]): T[] => db.prepare(sql).all(...params) as T[];

  const jobCount = one<{ c: number }>("SELECT COUNT(*) AS c FROM jobs").c;
  const candidateCount = one<{ c: number }>("SELECT COUNT(*) AS c FROM candidates").c;
  if (jobCount === 0) abort("database contains zero jobs — this is not the real corpus");
  if (candidateCount === 0) abort("database contains zero candidates — this is not the real corpus");
  record("database is populated", true, `${jobCount} jobs, ${candidateCount} candidates`);

  const tableNames = all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).map((r) => r.name);
  const countTables = (): TableCount[] =>
    tableNames.map((table) => ({ table, rows: one<{ c: number }>(`SELECT COUNT(*) AS c FROM "${table}"`).c }));
  const tableCountsBefore = countTables();

  // --- Phase 1: find an existing READY workflow -------------------------------------------------
  console.log("\nPHASE 1 — EXISTING APPROVED WORKFLOW");
  const workflowRows = all<ResumeQualityWorkflowRow>(
    "SELECT * FROM resume_quality_workflows WHERE candidate_id = ? ORDER BY id",
    CANDIDATE_ID
  );
  const candidates: AcceptanceWorkflowCandidate[] = workflowRows.map((w) => {
    const job = getJobByDedupeKey(w.dedupe_key);
    const company = job ? getCompany(job.company_id) : undefined;
    return {
      workflowId: w.id,
      candidateId: w.candidate_id,
      tailoringRunId: w.tailoring_run_id,
      dedupeKey: w.dedupe_key,
      status: w.status,
      finalApprovedIteration: w.final_approved_iteration,
      currentIteration: w.current_iteration,
      jobId: job?.id ?? null,
      jobTitle: job?.title ?? null,
      companyId: company?.id ?? null,
      companyName: company?.name ?? null,
    };
  });
  console.log(
    `  ${workflowRows.length} workflow(s) for candidate ${CANDIDATE_ID}; ` +
      `${candidates.filter((c) => c.status === "READY").length} READY`
  );

  const selection = selectAcceptanceWorkflow(candidates);
  if (!selection) {
    abort(
      `no READY resume-quality workflow exists for candidate ${CANDIDATE_ID}. This harness will not ` +
        `create or approve one — run a tailoring workflow to READY through the app first.`
    );
  }
  const chosen = selection.selected;
  record(
    "selected an existing READY workflow",
    true,
    selection.reason === "preferred"
      ? `preferred Stage 25C workflow (Celigo job ${PREFERRED.jobId})`
      : `deterministic fallback — highest READY workflow id (preferred Celigo job ${PREFERRED.jobId} not present as READY)`
  );

  const candidate = getCandidate(chosen.candidateId);
  const job = getJobByDedupeKey(chosen.dedupeKey);
  const company = job ? getCompany(job.company_id) : undefined;
  const tailoringRun = getTailoringRun(chosen.candidateId, chosen.tailoringRunId);
  if (!candidate) abort(`candidate ${chosen.candidateId} not found`);
  if (!job) abort(`job for dedupe_key ${chosen.dedupeKey} not found`);
  if (!company) abort(`company ${job.company_id} not found`);
  if (!tailoringRun) abort(`tailoring run ${chosen.tailoringRunId} not found`);

  const iterations = listResumeQualityIterations(chosen.candidateId, chosen.workflowId);
  const approvedIteration = chosen.finalApprovedIteration ?? chosen.currentIteration;
  if (!approvedIteration || approvedIteration <= 0) abort(`workflow ${chosen.workflowId} has no approved iteration recorded`);

  console.log(`    candidateId        : ${candidate.id} (${candidate.display_name})`);
  console.log(`    jobId              : ${job.id}`);
  console.log(`    company            : ${company.name} (id ${company.id})`);
  console.log(`    job title          : ${job.title}`);
  console.log(`    tailoringRunId     : ${tailoringRun.id}`);
  console.log(`    workflowId         : ${chosen.workflowId}`);
  console.log(`    approved iteration : ${approvedIteration} (of ${iterations.length} recorded)`);
  console.log(`    workflow status    : ${chosen.status}`);
  console.log(`    quality gate       : READY (implied by terminal READY status)`);

  // --- Phase 2: locate approved source artifacts + snapshot master files ------------------------
  console.log("\nPHASE 2 — APPROVED SOURCE ARTIFACTS");
  const location: QualityWorkflowLocation = {
    candidateId: chosen.candidateId,
    dedupeKey: chosen.dedupeKey,
    runId: chosen.tailoringRunId,
    workflowId: chosen.workflowId,
  };
  const finalDir = getFinalDirectory(location);
  if (!fs.existsSync(finalDir)) abort(`approved final/ directory does not exist: ${finalDir}`);

  const sourceResume = path.join(finalDir, finalResumeFilename(candidate.first_name));
  const sourceCover = path.join(finalDir, finalCoverLetterFilename(candidate.first_name));
  const sourceFeedback = path.join(finalDir, "resume_review_feedback.md");

  if (!fs.existsSync(sourceResume)) abort(`approved resume not found: ${sourceResume}`);
  const hasCover = fs.existsSync(sourceCover);
  const hasFeedback = fs.existsSync(sourceFeedback);

  const sourceResumeSha = sha256(sourceResume);
  const sourceCoverSha = hasCover ? sha256(sourceCover) : null;
  const sourceFeedbackSha = hasFeedback ? sha256(sourceFeedback) : null;

  console.log(`    final/            : ${finalDir}`);
  console.log(`    resume            : ${path.basename(sourceResume)}  sha256=${sourceResumeSha}`);
  console.log(`    cover letter      : ${hasCover ? `${path.basename(sourceCover)}  sha256=${sourceCoverSha}` : "(none)"}`);
  console.log(`    review feedback   : ${hasFeedback ? `resume_review_feedback.md  sha256=${sourceFeedbackSha}` : "(none)"}`);
  record("approved resume DOCX present in final/", true);

  const masterRoots = [
    path.join(process.cwd(), "data", "master"),
    path.join(process.cwd(), "data", "candidates", String(chosen.candidateId)),
  ];
  const masterBefore = masterRoots.map((root) => ({ root, files: snapshotDirectory(root) }));
  console.log(
    `    master snapshot   : ${masterBefore.map((m) => `${path.relative(process.cwd(), m.root)}=${m.files.length} file(s)`).join(", ")}`
  );

  // --- Phase 3: invoke the EXISTING publication module -------------------------------------------
  console.log("\nPHASE 3 — PUBLISH (existing module, READY gate intact)");
  let published: PublishedApplication;
  try {
    published = publishFinalApplicationArtifacts({
      candidateId: candidate.id,
      candidateFirstName: candidate.first_name,
      candidateDisplayName: candidate.display_name,
      companyId: company.id,
      companyName: company.name,
      jobId: job.id,
      jobTitle: job.title,
      dedupeKey: chosen.dedupeKey,
      applicationId: workflowRows.find((w) => w.id === chosen.workflowId)!.application_id,
      tailoringRunId: chosen.tailoringRunId,
      workflowId: chosen.workflowId,
      // The workflow's REAL status, straight from the row. The gate inside the module is not
      // bypassed, weakened, or stubbed — if this row were not READY, publication would throw.
      workflowStatus: chosen.status as ResumeQualityWorkflowRow["status"],
      iterationNumber: approvedIteration,
      qualityGateOutcome: "READY",
      overallScore: workflowRows.find((w) => w.id === chosen.workflowId)!.latest_overall_score,
      instructionVersion: INSTRUCTION_VERSION,
      instructionHash: INSTRUCTION_HASH,
      sourceFinalDirectory: finalDir,
      sourceResumePath: sourceResume,
      sourceCoverLetterPath: hasCover ? sourceCover : undefined,
      sourceReviewFeedbackPath: hasFeedback ? sourceFeedback : undefined,
      publishedAt: new Date().toISOString(),
    });
  } catch (error) {
    abort(`publication threw: ${error instanceof Error ? error.message : String(error)}`);
  }
  record("publication completed", true, published.directory);

  // --- Phase 4: verify the real filesystem result ------------------------------------------------
  console.log("\nPHASE 4 — PUBLISHED DIRECTORY");
  console.log(`    exact path        : ${published.directory}`);
  console.log(`    relative to repo  : ${path.relative(process.cwd(), published.directory)}`);
  record("published directory exists", fs.existsSync(published.directory));
  record(
    "published directory is inside the generated applications root",
    path.resolve(published.directory).startsWith(path.resolve(getGeneratedRoot(), "applications") + path.sep)
  );
  record("resume DOCX published", fs.existsSync(published.resumePath), path.basename(published.resumePath));
  if (hasCover) {
    record(
      "cover letter DOCX published",
      published.coverLetterPath !== null && fs.existsSync(published.coverLetterPath),
      published.coverLetterPath ? path.basename(published.coverLetterPath) : "missing"
    );
  } else {
    record("cover letter absent at source, correctly not published", published.coverLetterPath === null);
  }
  if (hasFeedback) {
    record(
      "review feedback published",
      published.reviewFeedbackPath !== null && fs.existsSync(published.reviewFeedbackPath),
      "resume_review_feedback.md"
    );
  } else {
    record("review feedback absent at source, correctly not published", published.reviewFeedbackPath === null);
  }
  record("manifest.json published", fs.existsSync(published.manifestPath));
  console.log(`    contents          : ${fs.readdirSync(published.directory).sort().join(", ")}`);

  // --- Phase 5: byte-match proof -----------------------------------------------------------------
  console.log("\nPHASE 5 — BYTE-MATCH PROOF");
  const publishedResumeSha = fs.existsSync(published.resumePath) ? sha256(published.resumePath) : "(missing)";
  console.log(`    resume source     : ${sourceResumeSha}`);
  console.log(`    resume published  : ${publishedResumeSha}`);
  record("resume bytes match the approved artifact", publishedResumeSha === sourceResumeSha);

  if (hasCover && published.coverLetterPath && fs.existsSync(published.coverLetterPath)) {
    const publishedCoverSha = sha256(published.coverLetterPath);
    console.log(`    cover source      : ${sourceCoverSha}`);
    console.log(`    cover published   : ${publishedCoverSha}`);
    record("cover letter bytes match the approved artifact", publishedCoverSha === sourceCoverSha);
  }
  if (hasFeedback && published.reviewFeedbackPath && fs.existsSync(published.reviewFeedbackPath)) {
    const publishedFeedbackSha = sha256(published.reviewFeedbackPath);
    console.log(`    feedback source   : ${sourceFeedbackSha}`);
    console.log(`    feedback published: ${publishedFeedbackSha}`);
    record("review feedback bytes match the approved artifact", publishedFeedbackSha === sourceFeedbackSha);
  }

  // --- Phase 6: manifest proof -------------------------------------------------------------------
  console.log("\nPHASE 6 — MANIFEST");
  const rawManifest = fs.readFileSync(published.manifestPath, "utf-8");
  let parsedManifest: unknown;
  try {
    parsedManifest = JSON.parse(rawManifest);
  } catch (error) {
    parsedManifest = null;
    record("manifest.json parses", false, error instanceof Error ? error.message : String(error));
  }
  const identityFailures = verifyManifestIdentity(parsedManifest, {
    candidateId: candidate.id,
    candidateName: candidate.display_name,
    companyId: company.id,
    companyName: company.name,
    jobId: job.id,
    jobTitle: job.title,
    tailoringRunId: chosen.tailoringRunId,
    workflowId: chosen.workflowId,
    iterationId: approvedIteration,
    workflowStatus: "READY",
    qualityGateOutcome: "READY",
    resumeSha256: sourceResumeSha,
    coverLetterSha256: sourceCoverSha,
  });
  record("manifest identifies the correct candidate/company/job/run/workflow/iteration", identityFailures.length === 0, identityFailures.join("; "));

  const forbidden = findForbiddenManifestContent(rawManifest);
  record("manifest contains no secrets", forbidden.length === 0, forbidden.join(", "));
  record("manifest carries no JD text", !rawManifest.includes(job.description_text?.slice(0, 60) ?? " never"), "");

  // --- Phase 7: master-file immutability ---------------------------------------------------------
  console.log("\nPHASE 7 — CANDIDATE MASTER FILES");
  for (const { root, files } of masterBefore) {
    const nowFiles = snapshotDirectory(root);
    const drift = diffSnapshots(files, nowFiles);
    record(
      `${path.relative(process.cwd(), root) || root} unchanged (bytes + mtimes)`,
      drift.length === 0,
      drift.length === 0 ? `${files.length} file(s) verified` : drift.join("; ")
    );
  }

  // --- Phase 8: collision + failure-preservation proof (no production mutation) -------------------
  console.log("\nPHASE 8 — COLLISION & NON-READY REFUSAL");
  const sameCompanyOtherJob = resolvePublishedApplicationTarget({
    companyId: company.id,
    companyName: company.name,
    jobId: job.id + 1,
    jobTitle: job.title,
  });
  record(
    "same company + different job resolves to a different folder",
    sameCompanyOtherJob.directory !== published.directory,
    `${path.basename(published.directory)} vs ${path.basename(sameCompanyOtherJob.directory)}`
  );

  const goodResumeShaBefore = sha256(published.resumePath);
  let refused = false;
  try {
    publishFinalApplicationArtifacts({
      candidateId: candidate.id,
      candidateFirstName: candidate.first_name,
      candidateDisplayName: candidate.display_name,
      companyId: company.id,
      companyName: company.name,
      jobId: job.id,
      jobTitle: job.title,
      dedupeKey: chosen.dedupeKey,
      applicationId: workflowRows.find((w) => w.id === chosen.workflowId)!.application_id,
      tailoringRunId: chosen.tailoringRunId,
      workflowId: chosen.workflowId,
      workflowStatus: "IMPROVEMENT_RUNNING",
      iterationNumber: approvedIteration,
      sourceFinalDirectory: finalDir,
      sourceResumePath: sourceResume,
      publishedAt: new Date().toISOString(),
    });
  } catch {
    refused = true;
  }
  record("a non-READY workflow is refused", refused);
  record("the last known-good publication survived the refusal", sha256(published.resumePath) === goodResumeShaBefore);

  // --- Phase 9: DB integrity + mutation accounting -----------------------------------------------
  console.log("\nPHASE 9 — DATABASE");
  const integrity = all<{ integrity_check: string }>("PRAGMA integrity_check").map((r) => r.integrity_check);
  record("PRAGMA integrity_check", integrity.length === 1 && integrity[0] === "ok", integrity.join("; "));

  const fkViolations = all<Record<string, unknown>>("PRAGMA foreign_key_check");
  record("PRAGMA foreign_key_check", fkViolations.length === 0, `${fkViolations.length} violation(s)`);

  const tableDrift = diffTableCounts(tableCountsBefore, countTables());
  record(
    "no production table changed",
    tableDrift.length === 0,
    tableDrift.length === 0 ? `${tableCountsBefore.length} tables verified` : tableDrift.join("; ")
  );
  console.log("    production mutations caused by publication: filesystem only —");
  console.log(`      ${path.relative(process.cwd(), published.directory)}/ (approved artifacts mirrored, no DB write)`);
  console.log("    paid provider invocations : 0 (this harness makes no network calls)");
  console.log("    applications submitted    : 0");

  // --- Verdict -----------------------------------------------------------------------------------
  console.log();
  rule();
  if (failures.length === 0) {
    console.log("PHASE 9A REAL-CORPUS ACCEPTANCE PASSED");
    rule();
    return 0;
  }
  console.log(`PHASE 9A REAL-CORPUS ACCEPTANCE FAILED — ${failures.length} invariant(s) failed:`);
  for (const f of failures) console.log(`  - ${f}`);
  rule();
  return 1;
}

const isEntrypoint =
  typeof process.argv[1] === "string" && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  process.exit(runAcceptance());
}
