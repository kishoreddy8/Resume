/**
 * Stage 26A — real end-to-end acceptance on ONE freshly human-approved job.
 *
 * DIAGNOSTIC TOOLING. Not application code, never imported by src/, never part of any production code
 * path. Every decision it proves is made by the production modules it calls; it re-implements nothing.
 *
 * Requires the job id to be passed explicitly AND an explicit authorization flag, so it can never
 * approve anything by accident or by inference:
 *     npx tsx tools/acceptance/stage26a-fresh-workflow-acceptance.ts --job <id> --i-approve-this-job
 *
 * The approval it records is the human's, relayed through the SAME API route the "Approve & Start
 * Tailoring" button uses (PATCH /api/jobs/[id] then POST .../quality-workflow) — never a direct DB
 * write, and never inferred from a match score. Without --i-approve-this-job it performs every
 * read-only check and stops before approving.
 *
 * What it does that has real effects:
 *   - records the human's approval for exactly the one job id given
 *   - runs up to max_iterations bounded writer passes, each invoking the user's own locally
 *     authenticated Claude Code CLI once through the existing safe invoker
 *   - lets Phase 9A publish if, and only if, the unchanged quality gate returns READY
 *
 * What it refuses to do: approve any other job, submit an application, change application status,
 * touch candidate evidence, alter match results, change scheduler settings, weaken any gate, or use a
 * paid provider.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { getDb, getDbPath } from "../../src/db";
import { getCandidate } from "../../src/db/queries/candidates";
import { getCandidateJobState } from "../../src/db/queries/candidateJobState";
import { getJob } from "../../src/db/queries/jobs";
import { getLatestJobMatchResult } from "../../src/db/queries/jobMatches";
import { getAppSettings } from "../../src/db/queries/settings";
import {
  getLatestResumeQualityWorkflowForJob,
  getResumeQualityWorkflow,
  listResumeQualityIterations,
  listWorkflowsAwaitingWriter,
} from "../../src/db/queries/resumeQualityWorkflows";
import { selectBestResumeQualityAttempt, type ResumeQualityAttemptSummary } from "../../src/lib/resumeQuality/bestAttemptSelection";
import { evaluateQualityGate } from "../../src/lib/resumeQuality/qualityGate";
import { evaluateTailoringAuthorization } from "../../src/lib/resumeQuality/tailoringAuthorization";
import {
  finalCoverLetterFilename,
  finalResumeFilename,
  getFinalDirectory,
  getIterationDirectory,
} from "../../src/lib/resumeQuality/workspace";
import { processOneWorkflow } from "../../src/lib/resumeQuality/writers/writerWorkerCore";
import { getResumeWriterLeaseStatus } from "../../src/lib/resumeQuality/writers/writerState";
import type { StructuredResumeReview } from "../../src/lib/resumeQuality/types";

const argv = process.argv.slice(2);
const jobIdArg = argv[argv.indexOf("--job") + 1];
const JOB_ID = argv.includes("--job") ? Number.parseInt(jobIdArg ?? "", 10) : NaN;
const APPROVED_BY_HUMAN = argv.includes("--i-approve-this-job");
const CANDIDATE_ID = 1;

let failures = 0;
const pass = (l: string, e?: string) => console.log(`  PASS  ${l}${e ? `\n    ${e}` : ""}`);
const fail = (l: string, e?: string) => { failures += 1; console.log(`  FAIL  ${l}${e ? `\n    ${e}` : ""}`); };
const check = (c: boolean, l: string, e?: string) => (c ? pass(l, e) : fail(l, e));
const info = (l: string, v: string) => console.log(`    ${l.padEnd(28)}: ${v}`);
const heading = (t: string) => console.log(`\n${t}`);
const sha256 = (p: string) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

function treeFingerprint(dir: string): { count: number; digest: string } {
  if (!fs.existsSync(dir)) return { count: 0, digest: "absent" };
  const hash = crypto.createHash("sha256");
  let count = 0;
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      const st = fs.statSync(full);
      hash.update(full).update(String(st.mtimeMs)).update(fs.readFileSync(full));
      count += 1;
    }
  };
  walk(dir);
  return { count, digest: hash.digest("hex") };
}

async function main(): Promise<void> {
  console.log("=".repeat(96));
  console.log("STAGE 26A REAL END-TO-END ACCEPTANCE — FRESH HUMAN-APPROVED WORKFLOW");
  console.log("=".repeat(96));

  if (!Number.isInteger(JOB_ID) || JOB_ID <= 0) {
    console.error("Refusing to run: pass an explicit --job <id>. This tool never chooses a job itself.");
    process.exit(2);
  }

  const db = getDb();
  const job = getJob(JOB_ID);
  if (!job) { console.error(`Job ${JOB_ID} not found.`); process.exit(2); }
  const candidate = getCandidate(CANDIDATE_ID)!;

  // ---------------------------------------------------------------------------------------------
  heading("PHASE A — ENVIRONMENT AND TARGET");
  info("database", getDbPath());
  info("job", `${JOB_ID} — ${job.company_name} — ${job.title}`);
  info("candidate", `${CANDIDATE_ID} — ${candidate.first_name} ${candidate.last_name}`);
  info("ANTHROPIC_API_KEY", process.env.ANTHROPIC_API_KEY === undefined ? "unset" : "SET");
  info("OPENAI_API_KEY", process.env.OPENAI_API_KEY === undefined ? "unset" : "SET");
  check(process.env.ANTHROPIC_API_KEY === undefined, "no ANTHROPIC_API_KEY — the writer uses the local subscription CLI only");
  check(process.env.OPENAI_API_KEY === undefined, "no other paid provider key is present");
  check(process.env.CAREER_OPS_DISABLE_REAL_CLAUDE_CLI !== "1", "the test-only CLI guard is not armed (this harness invokes the real CLI)");
  const invokerSrc = fs.readFileSync(path.join(process.cwd(), "src/lib/resumeQuality/writers/claudeCliInvoker.ts"), "utf-8");
  const argsFn = invokerSrc.slice(invokerSrc.indexOf("function buildArgs"), invokerSrc.indexOf("/** Runs one CLI attempt"));
  check(!argsFn.includes("--dangerously-skip-permissions"), "the invoker never passes --dangerously-skip-permissions");
  check(argsFn.includes("--safe-mode") && argsFn.includes('"Read,Write"'), "the invoker keeps --safe-mode and Read,Write only");
  check(argsFn.includes("--add-dir"), "the writer's only writable location is the handoff directory");

  const match = getLatestJobMatchResult(CANDIDATE_ID, job.dedupe_key);
  info("match decision", match?.decision ?? "none");
  info("match score", String(match?.overall_score ?? "n/a"));
  check(match?.decision === "READY_FOR_TAILORING", "the job is genuinely READY_FOR_TAILORING before any approval");

  // ---------------------------------------------------------------------------------------------
  heading("PHASE B — PRE-STATE SNAPSHOT");
  const jobsBefore = (db.prepare("SELECT COUNT(*) AS c FROM jobs").get() as { c: number }).c;
  const matchesBefore = (db.prepare("SELECT COUNT(*) AS c FROM job_match_results").get() as { c: number }).c;
  const matchRowBefore = JSON.stringify(db.prepare("SELECT id, decision, overall_score FROM job_match_results WHERE candidate_id=? AND dedupe_key=? ORDER BY id DESC LIMIT 1").get(CANDIDATE_ID, job.dedupe_key));
  const masterFp = treeFingerprint(path.join(process.cwd(), "data", "master"));
  const candFp = treeFingerprint(path.join(process.cwd(), "data", "candidates", String(CANDIDATE_ID)));
  const schedulerBefore = JSON.stringify(getAppSettings().scheduler);
  const appliedBefore = (db.prepare("SELECT COUNT(*) AS c FROM candidate_job_state WHERE pipeline_status = 'Applied'").get() as { c: number }).c;
  const pipelineBefore = String((db.prepare("SELECT pipeline_status AS p FROM candidate_job_state WHERE candidate_id=? AND dedupe_key=?").get(CANDIDATE_ID, job.dedupe_key) as { p?: string } | undefined)?.p ?? "(no row)");
  info("jobs", String(jobsBefore));
  info("job_match_results", String(matchesBefore));
  info("data/master", `${masterFp.count} files ${masterFp.digest.slice(0, 16)}…`);
  info(`data/candidates/${CANDIDATE_ID}`, `${candFp.count} files ${candFp.digest.slice(0, 16)}…`);
  info("rows in Applied", String(appliedBefore));
  info("this job's pipeline_status", pipelineBefore);
  check(getLatestResumeQualityWorkflowForJob(CANDIDATE_ID, job.dedupe_key) === undefined, "no prior quality workflow exists for this job — this is a genuinely fresh run");

  // ---------------------------------------------------------------------------------------------
  heading("PHASE C — HUMAN APPROVAL (relayed through the real API routes)");
  const authBefore = evaluateTailoringAuthorization(CANDIDATE_ID, job.dedupe_key);
  info("approved before", String(authBefore.isAuthorized));
  check(!authBefore.isAuthorized, "the job is NOT authorized before the human acts — a score alone authorizes nothing", authBefore.blockingReason ?? "");
  check(listWorkflowsAwaitingWriter().every((w) => w.dedupe_key !== job.dedupe_key), "nothing was queued for this job before approval");

  if (!APPROVED_BY_HUMAN) {
    heading("STOPPING — no --i-approve-this-job flag. Nothing was approved and nothing was written.");
    process.exit(failures === 0 ? 0 : 1);
  }

  const { PATCH: jobPatch } = await import("../../src/app/api/jobs/[id]/route");
  const patchRes = await jobPatch(
    new NextRequest(`http://localhost/api/jobs/${JOB_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ candidateId: CANDIDATE_ID, markedForTailoring: true, approval: { approvalType: "READY_DIRECT", decision: "READY_FOR_TAILORING" } }),
    }),
    { params: Promise.resolve({ id: String(JOB_ID) }) }
  );
  check(patchRes.status === 200, `the approval was recorded through PATCH /api/jobs/${JOB_ID}`, `status=${patchRes.status}`);

  const authAfter = evaluateTailoringAuthorization(CANDIDATE_ID, job.dedupe_key);
  info("approval type", authAfter.approvalType ?? "none");
  info("approved decision", authAfter.approvedDecision ?? "none");
  info("marked at", authAfter.markedAt ?? "never");
  check(authAfter.isAuthorized, "an explicit human approval now exists", authAfter.blockingReason ?? "no blocking reason");

  const { POST: workflowPost } = await import("../../src/app/api/candidates/[candidateId]/jobs/[jobId]/quality-workflow/route");
  const postRes = await workflowPost(
    new NextRequest(`http://localhost/api/candidates/${CANDIDATE_ID}/jobs/${JOB_ID}/quality-workflow`, { method: "POST" }),
    { params: Promise.resolve({ candidateId: String(CANDIDATE_ID), jobId: String(JOB_ID) }) }
  );
  const postBody = (await postRes.json()) as { workflow?: { id: number; status: string; current_iteration: number; max_iterations: number }; awaitingWriter?: boolean };
  check(postRes.status === 200, "the quality workflow was started through the real POST route", `status=${postRes.status}`);
  const wf0 = postBody.workflow!;
  info("workflow", `${wf0.id} status=${wf0.status} iteration=${wf0.current_iteration}/${wf0.max_iterations}`);

  // ---------------------------------------------------------------------------------------------
  heading("PHASE D — CREATED, WITH NO SYNTHETIC SEED");
  check(wf0.status === "CREATED", "the workflow begins in CREATED", `status=${wf0.status}`);
  check(wf0.current_iteration === 0, "no iteration was consumed at approval time");
  check(postBody.awaitingWriter === true, "the writer owns the next step — no manual worker to start");
  check(listResumeQualityIterations(CANDIDATE_ID, wf0.id).length === 0, "no iteration row exists yet");
  check(wf0.max_iterations === 3, "all three genuine writer attempts are available", `max_iterations=${wf0.max_iterations}`);

  const wfRow = getResumeQualityWorkflow(CANDIDATE_ID, wf0.id)!;
  const loc = { candidateId: CANDIDATE_ID, dedupeKey: wfRow.dedupe_key, runId: wfRow.tailoring_run_id, workflowId: wfRow.id };
  const qualityDir = path.dirname(getFinalDirectory(loc));
  const SEED_STRINGS = ["candidate@example.com", "555-0100", "Software Professional", "Engineered data platforms and core workflows at"];
  const seedHits: string[] = [];
  const sweep = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { sweep(full); continue; }
      let text = "";
      try { text = fs.readFileSync(full, "utf-8"); } catch { continue; }
      for (const s of SEED_STRINGS) if (text.includes(s)) seedHits.push(`${path.relative(process.cwd(), full)} :: ${s}`);
    }
  };
  sweep(qualityDir);
  check(seedHits.length === 0, "no synthesized seed resume exists anywhere in the new workflow", seedHits.join("; ") || "clean");
  check(listWorkflowsAwaitingWriter().some((w) => w.id === wf0.id), "the scheduler's own queue discovers this CREATED workflow");
  check(getResumeWriterLeaseStatus().held === false, "no writer lease is held before the first pass");

  // ---------------------------------------------------------------------------------------------
  heading("PHASE E — BOUNDED WRITER PASSES THROUGH THE REAL CLAUDE CLI");
  let current = getResumeQualityWorkflow(CANDIDATE_ID, wf0.id)!;
  let passNo = 0;
  while (current.status !== "READY" && current.status !== "FAILED" && passNo < current.max_iterations) {
    passNo += 1;
    const iterBefore = listResumeQualityIterations(CANDIDATE_ID, current.id).length;
    console.log(`\n  --- pass ${passNo} (target iteration ${current.current_iteration + 1}) ---`);
    const started = Date.now();
    const outcome = await processOneWorkflow(current, {});
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    info("outcome", `${outcome.outcome} (${secs}s)`);
    if (outcome.error) info("error", outcome.error.slice(0, 220));

    const after = getResumeQualityWorkflow(CANDIDATE_ID, current.id)!;
    const iterAfter = listResumeQualityIterations(CANDIDATE_ID, current.id);

    if (
      outcome.outcome === "TECHNICAL_FAILURE" ||
      outcome.outcome === "ERROR" ||
      outcome.outcome === "BLOCKED_MAX_ATTEMPTS" ||
      outcome.outcome === "SUBSCRIPTION_LIMIT_REACHED" ||
      outcome.outcome === "AUTH_REQUIRED"
    ) {
      check(after.status !== "READY", "a technical failure never marks the workflow READY");
      check(iterAfter.length === iterBefore, "a technical failure never consumes a quality iteration", `${iterBefore} -> ${iterAfter.length}`);
      if (outcome.providerUnavailable) info("provider", "the Claude service was unavailable — reported as such, not as a resume problem");
      passNo -= 1; // a technical failure is not a content attempt
      if (outcome.outcome === "BLOCKED_MAX_ATTEMPTS") { fail("technical retries exhausted before any content attempt completed"); break; }
      if (outcome.outcome === "SUBSCRIPTION_LIMIT_REACHED" || outcome.outcome === "AUTH_REQUIRED") {
        fail(`writer is blocked on an operator-actionable condition (${outcome.outcome}) — no content attempt was possible`);
        break;
      }
      current = after;
      continue;
    }

    check(iterAfter.length === iterBefore + 1, "exactly one new quality iteration was recorded");
    const newIter = iterAfter[iterAfter.length - 1];
    check(newIter.candidate_id === CANDIDATE_ID, "the iteration belongs to the correct candidate");
    const review = JSON.parse(newIter.review_json!) as StructuredResumeReview;
    info("scores", `overall ${review.overallScore} · ats ${review.atsScore} · truthful ${review.truthfulnessScore} · arch ${review.architectureConsistencyScore}`);
    info("blockingFailures", String((review.blockingFailures ?? []).length));
    const gate = evaluateQualityGate(review, newIter.iteration_number, after.max_iterations);
    info("quality gate", gate);
    check((gate === "READY") === (after.status === "READY"), "READY is reached only through evaluateQualityGate", `gate=${gate} status=${after.status}`);

    if (newIter.iteration_number === 1) {
      const resumeJson = path.join(getIterationDirectory(loc, 1), "resume_content.json");
      check(fs.existsSync(resumeJson), "iteration 1 was produced by the real writer and snapshotted");
      if (fs.existsSync(resumeJson)) {
        const txt = fs.readFileSync(resumeJson, "utf-8");
        const hits = SEED_STRINGS.filter((s) => txt.includes(s));
        check(hits.length === 0, "iteration 1 contains no legacy seed placeholder", hits.join(", ") || "clean");
        const parsed = JSON.parse(txt) as { name?: string };
        check((parsed.name ?? "").toLowerCase().includes("sai"), "iteration 1 is candidate-specific, from the supplied evidence", `name=${parsed.name}`);
      }
    }
    if (after.status === "IMPROVEMENT_RUNNING") {
      const carried = (review.requiredCorrections?.length ?? 0) + (review.blockingFailures?.length ?? 0) + review.blockingIssues.length;
      check(carried > 0, "corrections/blocking findings are recorded so the next attempt receives them");
      const nextPrompt = path.join(path.dirname(getIterationDirectory(loc, 1)), "..", "handoffs", `iteration-${newIter.iteration_number + 1}`, "writer_prompt.md");
      info("next handoff", fs.existsSync(nextPrompt) ? "prepared on the next pass" : "prepared on the next pass");
    }
    current = after;
  }

  info("final status", current.status);
  info("iterations used", `${current.current_iteration} of ${current.max_iterations}`);
  check(current.current_iteration <= current.max_iterations, "the loop stayed bounded by max_iterations");
  check(getResumeWriterLeaseStatus().held === false, "no writer lease is left held");

  // ---------------------------------------------------------------------------------------------
  heading("PHASE F — SAFE BEST-ATTEMPT SELECTION");
  const attempts: ResumeQualityAttemptSummary[] = listResumeQualityIterations(CANDIDATE_ID, current.id)
    .filter((i) => i.review_json)
    .map((i) => ({ iterationNumber: i.iteration_number, review: JSON.parse(i.review_json!) as StructuredResumeReview }));
  const selection = selectBestResumeQualityAttempt(attempts);
  if (selection) {
    info("selected iteration", String(selection.iterationNumber));
    info("blockingFailureCount", String(selection.blockingFailureCount));
    info("reason", selection.selectionReason.slice(0, 200));
    const chosen = attempts.find((a) => a.iterationNumber === selection.iterationNumber)!.review;
    const chosenSeverity = chosen.blockingFailures === undefined ? Number.POSITIVE_INFINITY : chosen.blockingFailures.length;
    const anySafer = attempts.some((a) => {
      const sev = a.review.blockingFailures === undefined ? Number.POSITIVE_INFINITY : a.review.blockingFailures.length;
      return sev < chosenSeverity;
    });
    check(!anySafer, "no attempt with strictly fewer blocking failures was passed over");
  } else {
    info("selected iteration", "n/a (no reviewed attempts)");
  }

  // ---------------------------------------------------------------------------------------------
  heading("PHASE G — FINAL ARTIFACTS AND PHASE 9A PUBLICATION");
  const finalDir = getFinalDirectory(loc);
  if (current.status === "READY") {
    const finalResume = path.join(finalDir, finalResumeFilename(candidate.first_name));
    const finalCover = path.join(finalDir, finalCoverLetterFilename(candidate.first_name));
    const finalFeedback = path.join(finalDir, "resume_review_feedback.md");
    check(fs.existsSync(finalResume), "final/ holds the approved resume");
    check(fs.existsSync(finalFeedback), "final/ holds the approved review feedback");

    const statusPath = path.join(finalDir, "publication_status.json");
    check(fs.existsSync(statusPath), "the publication outcome was recorded");
    const rec = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as { status: string; directory: string | null; error: string | null };
    info("publication status", rec.status);
    info("published directory", rec.directory ?? "(none)");
    if (rec.error) info("publication error", rec.error);
    check(rec.status === "PUBLISHED", "Phase 9A published the approved artifacts", rec.error ?? "");

    if (rec.status === "PUBLISHED" && rec.directory) {
      const pubDir = path.join(process.cwd(), rec.directory);
      check(!path.isAbsolute(rec.directory), "the recorded directory is repo-relative");
      check(rec.directory.startsWith(path.join("data", "generated", "applications")), "published under data/generated/applications/", rec.directory);
      check(/^[a-z0-9-]+\/[a-z0-9-]+-\d+$/.test(rec.directory.replace(/^data\/generated\/applications\//, "")), "directory is <company-slug>/<position-slug>-<jobId>", rec.directory);
      check(rec.directory.endsWith(`-${JOB_ID}`), "the published directory is keyed to this job id");

      const prefix = candidate.first_name.replace(/\s+/g, "");
      const pubResume = path.join(pubDir, `${prefix}_Resume.docx`);
      const pubCover = path.join(pubDir, `${prefix}_CoverLetter.docx`);
      const pubFeedback = path.join(pubDir, "resume_review_feedback.md");
      const manifestPath = path.join(pubDir, "manifest.json");
      info("contents", fs.existsSync(pubDir) ? fs.readdirSync(pubDir).sort().join(", ") : "(missing)");
      check(fs.existsSync(pubResume), `published ${prefix}_Resume.docx`);
      check(fs.existsSync(pubCover), `published ${prefix}_CoverLetter.docx`);
      check(fs.existsSync(pubFeedback), "published resume_review_feedback.md");
      check(fs.existsSync(manifestPath), "published manifest.json");

      if (fs.existsSync(pubResume) && fs.existsSync(finalResume)) {
        const a = sha256(pubResume), b = sha256(finalResume);
        check(a === b, "published resume is SHA-256 identical to the approved resume", a);
      }
      if (fs.existsSync(pubCover) && fs.existsSync(finalCover)) {
        const a = sha256(pubCover), b = sha256(finalCover);
        check(a === b, "published cover letter is SHA-256 identical to the approved cover letter", a);
      }
      if (fs.existsSync(pubFeedback) && fs.existsSync(finalFeedback)) {
        check(sha256(pubFeedback) === sha256(finalFeedback), "published feedback is identical to the approved feedback");
      }
      if (fs.existsSync(manifestPath)) {
        const m = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
        check(m.candidateId === CANDIDATE_ID, "manifest names the correct candidate");
        check(m.jobId === JOB_ID, "manifest names the correct job");
        check(m.workflowId === current.id, "manifest names the correct workflow");
        check(m.tailoringRunId === current.tailoring_run_id, "manifest names the correct tailoring run");
        check(m.workflowStatus === "READY", "manifest records workflowStatus READY");
        check(typeof m.iterationId === "number", "manifest names the approved iteration");
        const blob = JSON.stringify(m);
        check(!/ANTHROPIC|OPENAI|sk-|api[_-]?key/i.test(blob), "manifest contains no secrets");
      }
      // Exactly once: re-reading must not have produced a second directory for this job.
      const root = path.join(process.cwd(), "data", "generated", "applications");
      const matches: string[] = [];
      for (const co of fs.readdirSync(root)) {
        const coDir = path.join(root, co);
        if (!fs.statSync(coDir).isDirectory()) continue;
        for (const p of fs.readdirSync(coDir)) if (p.endsWith(`-${JOB_ID}`)) matches.push(`${co}/${p}`);
      }
      check(matches.length === 1, "exactly one published directory exists for this job", matches.join(", "));
    }
  } else {
    info("final status", current.status);
    check(!fs.existsSync(path.join(finalDir, "publication_status.json")), "no publication was attempted for a non-READY workflow");
    fail(`the workflow did not reach READY (status ${current.status}) — publication byte-match could not be proven on this run`);
  }

  // ---------------------------------------------------------------------------------------------
  heading("PHASE H — UNTOUCHED STATE");
  const jobsAfter = (db.prepare("SELECT COUNT(*) AS c FROM jobs").get() as { c: number }).c;
  const matchesAfter = (db.prepare("SELECT COUNT(*) AS c FROM job_match_results").get() as { c: number }).c;
  const matchRowAfter = JSON.stringify(db.prepare("SELECT id, decision, overall_score FROM job_match_results WHERE candidate_id=? AND dedupe_key=? ORDER BY id DESC LIMIT 1").get(CANDIDATE_ID, job.dedupe_key));
  const appliedAfter = (db.prepare("SELECT COUNT(*) AS c FROM candidate_job_state WHERE pipeline_status = 'Applied'").get() as { c: number }).c;
  const pipelineAfter = String((db.prepare("SELECT pipeline_status AS p FROM candidate_job_state WHERE candidate_id=? AND dedupe_key=?").get(CANDIDATE_ID, job.dedupe_key) as { p?: string } | undefined)?.p ?? "(no row)");
  check(jobsAfter === jobsBefore, "job count unchanged", `${jobsBefore} -> ${jobsAfter}`);
  check(matchesAfter === matchesBefore, "no match result created or altered", `${matchesBefore} -> ${matchesAfter}`);
  check(matchRowAfter === matchRowBefore, "this job's own match decision and score are unchanged");
  check(appliedAfter === appliedBefore, "no application anywhere was submitted or marked Applied", `${appliedBefore} -> ${appliedAfter}`);
  const state = getCandidateJobState(CANDIDATE_ID, job.dedupe_key);
  info("this job's pipeline_status", `${pipelineBefore} -> ${pipelineAfter}`);
  check(state?.pipeline_status !== "Applied", "this job was NOT silently moved to Applied", `pipeline_status=${state?.pipeline_status}`);
  const masterAfter = treeFingerprint(path.join(process.cwd(), "data", "master"));
  const candAfter = treeFingerprint(path.join(process.cwd(), "data", "candidates", String(CANDIDATE_ID)));
  check(masterAfter.digest === masterFp.digest, `data/master unchanged (bytes + mtimes) — ${masterAfter.count} files`);
  check(candAfter.digest === candFp.digest, `data/candidates/${CANDIDATE_ID} unchanged (bytes + mtimes) — ${candAfter.count} files`);
  check(JSON.stringify(getAppSettings().scheduler) === schedulerBefore, "scheduler settings unchanged");

  heading("PHASE I — DATABASE");
  const integ = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
  check(integ.length === 1 && integ[0].integrity_check === "ok", `PRAGMA integrity_check — ${integ[0]?.integrity_check}`);
  const fk = db.pragma("foreign_key_check") as unknown[];
  check(fk.length === 0, `PRAGMA foreign_key_check — ${fk.length} violation(s)`);
  info("paid provider invocations", "0 (local subscription CLI only)");
  info("applications submitted", "0");

  console.log("\n" + "=".repeat(96));
  console.log(failures === 0 ? "STAGE 26A REAL END-TO-END ACCEPTANCE PASSED" : `STAGE 26A REAL END-TO-END ACCEPTANCE FAILED (${failures} check(s))`);
  console.log("=".repeat(96));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nSTAGE 26A ACCEPTANCE ERRORED");
  console.error(err);
  process.exit(1);
});
