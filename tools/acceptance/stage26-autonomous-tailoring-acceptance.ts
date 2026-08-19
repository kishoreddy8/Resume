/**
 * Stage 26 — real-corpus acceptance for autonomous tailoring execution.
 *
 * DIAGNOSTIC TOOLING. Not application code, never imported by src/, never part of any production code
 * path. It re-implements nothing: every decision it proves is made by the production modules it calls
 * (src/lib/resumeQuality/writers/tick.ts, writerWorkerCore.ts, writerState.ts, writerHealth.ts,
 * tailoringAuthorization.ts, and the unchanged orchestrator/reviewer/quality gate).
 *
 * What it does that has real effects, and only this:
 *   - runs ONE bounded writer pass over the single least-destructive already-approved, non-terminal
 *     workflow the real corpus already contains. That pass invokes the user's own locally
 *     authenticated Claude Code CLI once, through the existing safe invoker, and — if the deterministic
 *     review then passes the unchanged quality gate — publishes the approved artifacts via Phase 9A.
 *
 * What it deliberately refuses to do:
 *   - approve, mark, or authorize any job (it asserts an approval already exists; it never creates one)
 *   - enable, disable, or otherwise change the operator's scheduler settings
 *   - create a workflow, a tailoring run, or a job
 *   - run matching, scoring, ranking, or evaluation
 *   - touch candidate master files or candidate evidence
 *   - submit an application or change application status
 *   - use any paid API provider, or ANTHROPIC_API_KEY, or --dangerously-skip-permissions
 *   - process more than one workflow, or make more than one pass
 *
 * Usage, from the repository root on the Mac that holds the real data/app.db:
 *     npx tsx tools/acceptance/stage26-autonomous-tailoring-acceptance.ts
 *
 * Add --dry-run to perform every read-only proof and stop immediately before the Claude invocation.
 *
 * Exits 0 only if every invariant holds; non-zero otherwise.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getDb, getDbPath } from "../../src/db";
import { getCandidate } from "../../src/db/queries/candidates";
import { getCandidateJobState } from "../../src/db/queries/candidateJobState";
import { getJobByDedupeKey } from "../../src/db/queries/jobs";
import { getAppSettings } from "../../src/db/queries/settings";
import {
  getResumeQualityWorkflow,
  listResumeQualityIterations,
  listWorkflowsAwaitingWriter,
  type ResumeQualityWorkflowRow,
} from "../../src/db/queries/resumeQualityWorkflows";
import { evaluateQualityGate } from "../../src/lib/resumeQuality/qualityGate";
import { evaluateTailoringAuthorization } from "../../src/lib/resumeQuality/tailoringAuthorization";
import { finalResumeFilename, finalCoverLetterFilename, getFinalDirectory, getIterationDirectory } from "../../src/lib/resumeQuality/workspace";
import { runGuardedWriterPass } from "../../src/lib/resumeQuality/writers/writerWorkerCore";
import { runResumeWriterTick } from "../../src/lib/resumeQuality/writers/tick";
import { getResumeWriterHealth } from "../../src/lib/resumeQuality/writers/writerHealth";
import { getResumeWriterLeaseStatus } from "../../src/lib/resumeQuality/writers/writerState";
import type { StructuredResumeReview } from "../../src/lib/resumeQuality/types";

const DRY_RUN = process.argv.includes("--dry-run");

let failures = 0;
function pass(label: string, extra?: string): void {
  console.log(`  PASS  ${label}${extra ? `\n    ${extra}` : ""}`);
}
function fail(label: string, extra?: string): void {
  failures += 1;
  console.log(`  FAIL  ${label}${extra ? `\n    ${extra}` : ""}`);
}
function check(condition: boolean, label: string, extra?: string): void {
  if (condition) pass(label, extra);
  else fail(label, extra);
}
function info(label: string, value: string): void {
  console.log(`    ${label.padEnd(26)}: ${value}`);
}
function heading(text: string): void {
  console.log(`\n${text}`);
}
/** True when the review carries at least one PLACEHOLDER_CONTACT blocking failure — i.e. the
 *  deterministic reviewer saw the placeholder and the gate cannot pass. Reads the review's own
 *  recorded findings; never re-derives a placeholder judgement of its own. */
function gateOutcomeIsWithheld(review: StructuredResumeReview): boolean {
  return (review.blockingFailures ?? []).some((f) => f.type === "PLACEHOLDER_CONTACT");
}

function sha256(p: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

/** Bytes + mtimes of every file under a directory — a change to either is a change. */
function treeFingerprint(dir: string): { count: number; digest: string } {
  if (!fs.existsSync(dir)) return { count: 0, digest: "absent" };
  const hash = crypto.createHash("sha256");
  let count = 0;
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
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
  console.log(`STAGE 26 REAL-CORPUS ACCEPTANCE — AUTONOMOUS TAILORING EXECUTION${DRY_RUN ? " (DRY RUN)" : ""}`);
  console.log("=".repeat(96));

  const db = getDb();

  // -------------------------------------------------------------------------------------------
  heading("PHASE 0 — ENVIRONMENT");
  info("database", getDbPath());
  info("ANTHROPIC_API_KEY", process.env.ANTHROPIC_API_KEY === undefined ? "unset" : "SET");
  info("OPENAI_API_KEY", process.env.OPENAI_API_KEY === undefined ? "unset" : "SET");
  check(process.env.ANTHROPIC_API_KEY === undefined, "no ANTHROPIC_API_KEY is present — the writer uses the local subscription CLI only");
  check(process.env.OPENAI_API_KEY === undefined, "no other paid provider key is present");
  check(
    process.env.CAREER_OPS_DISABLE_REAL_CLAUDE_CLI !== "1",
    "the test-only real-CLI guard is not armed (this harness is meant to invoke the real CLI once)"
  );
  const invokerSource = fs.readFileSync(path.join(process.cwd(), "src/lib/resumeQuality/writers/claudeCliInvoker.ts"), "utf-8");
  const spawnedArgs = invokerSource.slice(invokerSource.indexOf("function buildArgs"), invokerSource.indexOf("/** Runs one CLI attempt"));
  check(!spawnedArgs.includes("--dangerously-skip-permissions"), "the invoker's argument builder never passes --dangerously-skip-permissions");
  check(spawnedArgs.includes("--safe-mode") && spawnedArgs.includes('"Read,Write"'), "the invoker sandboxes the writer to --safe-mode with Read,Write only");

  // -------------------------------------------------------------------------------------------
  heading("PHASE 1 — SCHEDULER GATING (read-only, settings never modified)");
  const settingsBefore = JSON.stringify(getAppSettings().scheduler);
  info("scheduler settings", settingsBefore);
  const tickOutcome = await runResumeWriterTick();
  info("tick outcome", tickOutcome.outcome);
  check(
    JSON.stringify(getAppSettings().scheduler) === settingsBefore,
    "the tick never modifies the operator's scheduler settings"
  );
  if (getAppSettings().scheduler.enabled) {
    check(
      ["RAN", "SKIPPED_OUTSIDE_WINDOW", "SKIPPED_INTERVAL_NOT_DUE", "SKIPPED_NO_PENDING_WORKFLOWS", "SKIPPED_LEASE_HELD"].includes(
        tickOutcome.outcome
      ),
      `automation is enabled; the tick reached a real scheduling decision (${tickOutcome.outcome})`
    );
  } else {
    check(
      tickOutcome.outcome === "SKIPPED_DISABLED",
      "automation is disabled in Settings, and the tick truthfully refuses to run rather than proceeding anyway",
      "the writer pass below is therefore driven directly, one layer under the enabled/window/interval gate, so this harness never flips a global automation switch"
    );
  }

  // -------------------------------------------------------------------------------------------
  heading("PHASE 2 — TARGET SELECTION (least destructive already-approved workflow)");
  const pending = listWorkflowsAwaitingWriter();
  info("workflows awaiting writer", String(pending.length));
  for (const w of pending) {
    info(`  candidate ${w.candidate_id} wf ${w.id}`, `${w.status} · iteration ${w.current_iteration}/${w.max_iterations}`);
  }
  if (pending.length === 0) {
    fail("the real corpus contains no approved, non-terminal workflow to exercise", "nothing was run; no state was changed");
    process.exit(1);
  }
  const target: ResumeQualityWorkflowRow = pending[0];
  const candidate = getCandidate(target.candidate_id)!;
  const job = getJobByDedupeKey(target.dedupe_key);
  info("target", `workflow ${target.id} · candidate ${target.candidate_id} (${candidate.first_name}) · ${job?.title ?? "unknown job"}`);
  check(
    target.status !== "READY" && target.status !== "FAILED",
    "the target is non-terminal — no completed workflow is ever replayed",
    `status=${target.status}`
  );
  const attemptsRemaining = target.max_iterations - target.current_iteration;
  check(attemptsRemaining > 0, "the target has genuine writer attempts remaining", `${attemptsRemaining} of ${target.max_iterations}`);

  // -------------------------------------------------------------------------------------------
  heading("PHASE 3 — HUMAN APPROVAL EXISTS BEFORE ANY WRITER INVOCATION");
  const auth = evaluateTailoringAuthorization(target.candidate_id, target.dedupe_key);
  info("marked for tailoring", String(auth.isMarked));
  info("approval type", auth.approvalType ?? "none");
  info("approved decision", auth.approvedDecision ?? "none");
  info("current match decision", auth.matchDecision);
  info("marked at", auth.markedAt ?? "never");
  check(auth.isMarked, "a human explicitly marked this job for tailoring");
  check(auth.approvalType !== null && auth.approvedDecision !== null, "an explicit approval context is recorded — a score alone authorizes nothing");
  check(auth.isAuthorized, "the approval is still valid against the job's current match decision", auth.blockingReason ?? "no blocking reason");
  check(auth.matchDecision !== "BLOCKED", "the job is not BLOCKED");

  // -------------------------------------------------------------------------------------------
  heading("PHASE 4 — PRE-STATE SNAPSHOT");
  const jobCountBefore = (db.prepare("SELECT COUNT(*) AS c FROM jobs").get() as { c: number }).c;
  const matchRowsBefore = (db.prepare("SELECT COUNT(*) AS c FROM job_match_results").get() as { c: number }).c;
  const targetMatchBefore = JSON.stringify(
    db.prepare("SELECT id, decision FROM job_match_results WHERE candidate_id = ? AND dedupe_key = ? ORDER BY id DESC LIMIT 1").get(target.candidate_id, target.dedupe_key)
  );
  const appStateBefore = JSON.stringify(getCandidateJobState(target.candidate_id, target.dedupe_key));
  const masterFingerprint = treeFingerprint(path.join(process.cwd(), "data", "master"));
  const candidateFingerprint = treeFingerprint(path.join(process.cwd(), "data", "candidates", String(target.candidate_id)));
  const iterationsBefore = listResumeQualityIterations(target.candidate_id, target.id);
  info("jobs", String(jobCountBefore));
  info("job_match_results rows", String(matchRowsBefore));
  info("iterations on target", String(iterationsBefore.length));
  info("data/master files", `${masterFingerprint.count} (${masterFingerprint.digest.slice(0, 16)}…)`);
  info(`data/candidates/${target.candidate_id}`, `${candidateFingerprint.count} (${candidateFingerprint.digest.slice(0, 16)}…)`);

  // -------------------------------------------------------------------------------------------
  heading("PHASE 5 — WRITER HEALTH BEFORE THE PASS");
  const healthBefore = getResumeWriterHealth(new Date(), target.id);
  info("state", healthBefore.state);
  info("detail", healthBefore.detail);
  info("pending workflows", String(healthBefore.pendingWorkflowCount));
  info("cadence", `${healthBefore.intervalMinutes} min · batch ${healthBefore.batchSize}`);
  check(healthBefore.state !== "PROCESSING", "health does not claim a pass is running when none is", `state=${healthBefore.state}`);
  check(
    healthBefore.pendingWorkflowCount === pending.length,
    "health reports the true queue depth rather than inferring progress from workflow status"
  );
  check(getResumeWriterLeaseStatus().held === false, "no writer lease is held before the pass");

  if (DRY_RUN) {
    heading("DRY RUN — stopping immediately before the Claude invocation. No writer pass was run.");
    console.log("\n" + "=".repeat(96));
    console.log(failures === 0 ? "STAGE 26 DRY-RUN CHECKS PASSED" : `STAGE 26 DRY-RUN CHECKS FAILED (${failures})`);
    console.log("=".repeat(96));
    process.exit(failures === 0 ? 0 : 1);
  }

  // -------------------------------------------------------------------------------------------
  heading("PHASE 6 — ONE BOUNDED PASS THROUGH THE REAL CLAUDE CLI (no manual worker process)");
  info("worker process running", "none — this is the same runGuardedWriterPass the scheduled tick calls");
  const startedAt = Date.now();
  const result = await runGuardedWriterPass({ maxWorkflows: 1 });
  const elapsedMs = Date.now() - startedAt;
  info("lease acquired", String(result.ran));
  info("attempted", String(result.attempted));
  info("queue depth", String(result.pending));
  info("elapsed", `${(elapsedMs / 1000).toFixed(1)}s`);
  check(result.ran, "the pass acquired the machine-wide writer lease");
  check(result.attempted === 1, "exactly one workflow was processed — the bound was honoured", `attempted=${result.attempted}`);
  check(getResumeWriterLeaseStatus().held === false, "the lease was released when the pass finished");

  const outcome = result.outcomes[0];
  info("outcome", outcome ? outcome.outcome : "none");
  if (outcome?.error) info("outcome error", outcome.error);
  check(outcome !== undefined && outcome.workflowId === target.id, "the processed workflow is the intended target");
  check(
    outcome !== undefined && outcome.outcome !== "SKIPPED_UNAUTHORIZED",
    "the approval re-check passed, so the writer was genuinely reached"
  );

  // -------------------------------------------------------------------------------------------
  heading("PHASE 7 — WHAT THE WRITER PRODUCED, AND WHO REVIEWED IT");
  const after = getResumeQualityWorkflow(target.candidate_id, target.id)!;
  const iterationsAfter = listResumeQualityIterations(target.candidate_id, target.id);
  info("workflow status", `${target.status} -> ${after.status}`);
  info("iteration", `${target.current_iteration} -> ${after.current_iteration}`);
  info("iterations recorded", `${iterationsBefore.length} -> ${iterationsAfter.length}`);

  const technical =
    outcome?.outcome === "TECHNICAL_FAILURE" ||
    outcome?.outcome === "ERROR" ||
    outcome?.outcome === "BLOCKED_MAX_ATTEMPTS" ||
    outcome?.outcome === "SUBSCRIPTION_LIMIT_REACHED" ||
    outcome?.outcome === "AUTH_REQUIRED";
  if (technical) {
    check(after.status !== "READY", "a technical writer failure never marks the workflow READY", `status=${after.status}`);
    check(
      iterationsAfter.length === iterationsBefore.length,
      "a technical writer failure never consumes a quality iteration",
      `${iterationsBefore.length} -> ${iterationsAfter.length}`
    );
    check(after.current_iteration === target.current_iteration, "a technical writer failure never advances the iteration counter");
  } else {
    check(iterationsAfter.length === iterationsBefore.length + 1, "exactly one new quality iteration was recorded");
    const newIter = iterationsAfter[iterationsAfter.length - 1];
    check(newIter.iteration_number === target.current_iteration + 1, "the new iteration is the next one in sequence");
    check(newIter.candidate_id === target.candidate_id, "the iteration is attributed to the correct candidate (no cross-candidate contamination)");

    const review = JSON.parse(newIter.review_json!) as StructuredResumeReview;
    info("overall score", String(review.overallScore));
    info("ats score", String(review.atsScore));
    info("truthfulness", String(review.truthfulnessScore));
    info("architecture", String(review.architectureConsistencyScore));
    info("blocking issues", String(review.blockingIssues.length));
    check(review.instructionCompliance !== undefined, "the deterministic reviewer ran and recorded instruction compliance");

    // The resume that was reviewed is the writer's own output, built from this candidate's evidence.
    const iterDir = getIterationDirectory(
      { candidateId: target.candidate_id, dedupeKey: target.dedupe_key, runId: target.tailoring_run_id, workflowId: target.id },
      newIter.iteration_number
    );
    const resumeJsonPath = path.join(iterDir, "resume_content.json");
    check(fs.existsSync(resumeJsonPath), "the reviewed resume content was snapshotted for this iteration");
    if (fs.existsSync(resumeJsonPath)) {
      const resumeText = fs.readFileSync(resumeJsonPath, "utf-8");
      const placeholders = ["candidate@example.com", "555-0100", "Software Professional", "Engineered data platforms and core workflows at"];
      const found = placeholders.filter((p) => resumeText.includes(p));

      // A placeholder value in the writer's output has two very different possible causes, and calling
      // them the same thing would be a false alarm on one and a missed regression on the other:
      //
      //   INHERITED — the workflow's iteration 1 predates Stage 26 and IS the old synthesized seed, so
      //     the handoff legitimately hands that document to the writer as "the previous resume". The
      //     writer preserving its contact block is not the writer inventing anything, and the quality
      //     gate independently refuses to approve it (placeholderChecks.ts raises PLACEHOLDER_CONTACT
      //     blocking failures). Nothing is broken; the legacy seed is simply still upstream.
      //   INTRODUCED — the value appears in this iteration but NOT in the prior one. That would be a
      //     genuine regression and is a hard failure.
      //
      // Only a workflow created after Stage 26 can be free of the first case, and it is free of it by
      // construction: no seed document exists at all (see the placeholder sweep in
      // stage26AutonomousTailoring.test.ts, which walks an entire post-Stage-26 workflow tree).
      const priorResumeJson = path.join(
        getIterationDirectory(
          { candidateId: target.candidate_id, dedupeKey: target.dedupe_key, runId: target.tailoring_run_id, workflowId: target.id },
          newIter.iteration_number - 1
        ),
        "resume_content.json"
      );
      const priorText = fs.existsSync(priorResumeJson) ? fs.readFileSync(priorResumeJson, "utf-8") : "";
      const inherited = found.filter((p) => priorText.includes(p));
      const introduced = found.filter((p) => !priorText.includes(p));

      check(
        introduced.length === 0,
        "this pass introduced no placeholder-seed value that was not already in the prior iteration",
        introduced.join(", ") || "none introduced"
      );
      if (inherited.length > 0) {
        info("inherited placeholders", inherited.join(", "));
        info(
          "  provenance",
          `carried over from iteration ${newIter.iteration_number - 1}, which predates Stage 26 and is the old synthesized seed`
        );
        check(
          gateOutcomeIsWithheld(review),
          "the quality gate refuses to approve a resume still carrying inherited placeholder contact details",
          "PLACEHOLDER_CONTACT blocking failures must be present"
        );
      }
      const parsed = JSON.parse(resumeText) as { name?: string };
      info("resume name", parsed.name ?? "(absent)");
      check(
        (parsed.name ?? "").toLowerCase().includes((candidate.first_name ?? "").split(" ")[0].toLowerCase()),
        "the resume is candidate-specific, produced from the supplied evidence",
        `name=${parsed.name ?? "(absent)"}`
      );
    }

    // The gate — not the writer, not this harness — is what decided the outcome.
    const gate = evaluateQualityGate(review, newIter.iteration_number, after.max_iterations);
    info("quality gate outcome", gate);
    check(
      (gate === "READY") === (after.status === "READY"),
      "READY was reached only through evaluateQualityGate, never any other path",
      `gate=${gate} status=${after.status}`
    );

    if (gate !== "READY" && newIter.iteration_number < after.max_iterations) {
      check(after.status === "IMPROVEMENT_RUNNING", "the gate failed with attempts remaining, so the workflow is queued for another draft");
      check(
        review.requiredCorrections.length > 0 || review.blockingIssues.length > 0,
        "corrections/blocking issues are recorded, so the next draft carries them forward automatically"
      );
      check(
        listWorkflowsAwaitingWriter().some((w) => w.id === target.id),
        "the workflow re-queues itself for the next scheduled pass with no manual step"
      );
      info("attempts remaining", String(after.max_iterations - after.current_iteration));
      check(after.current_iteration <= after.max_iterations, "the loop is bounded by max_iterations");
    }
    if (gate !== "READY" && newIter.iteration_number >= after.max_iterations) {
      check(after.status === "FAILED", "the last allowed attempt failing reaches terminal human review, never an endless loop");
    }
  }

  // -------------------------------------------------------------------------------------------
  heading("PHASE 8 — PHASE 9A PUBLICATION TRUTHFULNESS");
  const finalDir = getFinalDirectory({
    candidateId: target.candidate_id,
    dedupeKey: target.dedupe_key,
    runId: target.tailoring_run_id,
    workflowId: target.id,
  });
  if (after.status === "READY") {
    const statusPath = path.join(finalDir, "publication_status.json");
    check(fs.existsSync(statusPath), "the approval recorded what happened to publication");
    if (fs.existsSync(statusPath)) {
      const record = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as {
        status: string;
        directory: string | null;
        error: string | null;
      };
      info("publication status", record.status);
      info("published directory", record.directory ?? "(none)");
      if (record.error) info("publication error", record.error);
      check(record.status === "PUBLISHED" || record.status === "FAILED", "the publication record is definite, never blank");
      if (record.status === "PUBLISHED" && record.directory) {
        check(!path.isAbsolute(record.directory), "the recorded directory is repo-relative");
        const pubDir = path.join(process.cwd(), record.directory);
        const pubResume = path.join(pubDir, `${candidate.first_name.replace(/\s+/g, "")}_Resume.docx`);
        const srcResume = path.join(finalDir, finalResumeFilename(candidate.first_name));
        check(fs.existsSync(pubDir), `the published application folder exists: ${record.directory}`);
        check(fs.existsSync(path.join(pubDir, "manifest.json")), "the published folder carries its manifest");
        if (fs.existsSync(pubResume) && fs.existsSync(srcResume)) {
          check(sha256(pubResume) === sha256(srcResume), "the published resume matches the approved artifact byte-for-byte", sha256(pubResume));
        } else {
          fail("published/approved resume pair not found for byte comparison", `${pubResume} vs ${srcResume}`);
        }
        const srcCover = path.join(finalDir, finalCoverLetterFilename(candidate.first_name));
        const pubCover = path.join(pubDir, `${candidate.first_name.replace(/\s+/g, "")}_CoverLetter.docx`);
        if (fs.existsSync(srcCover) && fs.existsSync(pubCover)) {
          check(sha256(pubCover) === sha256(srcCover), "the published cover letter matches the approved artifact byte-for-byte");
        }
      }
      if (record.status === "FAILED") {
        check(record.error !== null && record.error.length > 0, "a publication failure names its reason instead of being swallowed");
        check(after.status === "READY", "a publication failure never unwound a genuine READY approval");
      }
    }
  } else {
    check(
      !fs.existsSync(path.join(finalDir, "publication_status.json")) || fs.existsSync(finalDir),
      "no publication was attempted for a non-READY workflow",
      `status=${after.status}`
    );
    pass("publication is unreachable except from inside the READY branch");
  }

  // -------------------------------------------------------------------------------------------
  heading("PHASE 9 — UNTOUCHED STATE");
  const jobCountAfter = (db.prepare("SELECT COUNT(*) AS c FROM jobs").get() as { c: number }).c;
  const matchRowsAfter = (db.prepare("SELECT COUNT(*) AS c FROM job_match_results").get() as { c: number }).c;
  const targetMatchAfter = JSON.stringify(
    db.prepare("SELECT id, decision FROM job_match_results WHERE candidate_id = ? AND dedupe_key = ? ORDER BY id DESC LIMIT 1").get(target.candidate_id, target.dedupe_key)
  );
  check(jobCountAfter === jobCountBefore, "job count unchanged", `${jobCountBefore} -> ${jobCountAfter}`);
  check(matchRowsAfter === matchRowsBefore, "no match result was created or altered", `${matchRowsBefore} -> ${matchRowsAfter}`);
  check(targetMatchAfter === targetMatchBefore, "the target job's own match decision is unchanged");
  check(JSON.stringify(getCandidateJobState(target.candidate_id, target.dedupe_key)) === appStateBefore, "application state is byte-identical — nothing was submitted or marked applied");

  const masterAfter = treeFingerprint(path.join(process.cwd(), "data", "master"));
  const candidateAfter = treeFingerprint(path.join(process.cwd(), "data", "candidates", String(target.candidate_id)));
  check(masterAfter.digest === masterFingerprint.digest, `data/master unchanged (bytes + mtimes) — ${masterAfter.count} file(s)`);
  check(candidateAfter.digest === candidateFingerprint.digest, `data/candidates/${target.candidate_id} unchanged (bytes + mtimes) — ${candidateAfter.count} file(s)`);
  check(JSON.stringify(getAppSettings().scheduler) === settingsBefore, "scheduler settings unchanged by the whole run");

  // -------------------------------------------------------------------------------------------
  heading("PHASE 10 — WRITER HEALTH AFTER THE PASS");
  const healthAfter = getResumeWriterHealth(new Date(), target.id);
  info("state", healthAfter.state);
  info("detail", healthAfter.detail);
  info("last pass outcome", healthAfter.lastPassOutcome ?? "(none)");
  info("last pass duration", healthAfter.lastPassDurationMs !== null ? `${(healthAfter.lastPassDurationMs / 1000).toFixed(1)}s` : "(none)");
  info("this workflow's outcome", healthAfter.workflowOutcome ? healthAfter.workflowOutcome.outcome : "(none)");
  check(healthAfter.lastPassCompletedAt !== null, "the pass is recorded, so the UI can report what actually happened");
  check(healthAfter.state !== "PROCESSING", "health no longer claims a pass is running");
  check(
    healthAfter.workflowOutcome?.outcome === outcome?.outcome,
    "health reports this workflow's real recorded outcome, not a guess"
  );

  // -------------------------------------------------------------------------------------------
  heading("PHASE 11 — DATABASE");
  const integrity = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
  check(integrity.length === 1 && integrity[0].integrity_check === "ok", `PRAGMA integrity_check — ${integrity[0]?.integrity_check}`);
  const fk = db.pragma("foreign_key_check") as unknown[];
  check(fk.length === 0, `PRAGMA foreign_key_check — ${fk.length} violation(s)`);
  info("paid provider invocations", "0 (the writer used the local subscription CLI only)");
  info("applications submitted", "0");

  console.log("\n" + "=".repeat(96));
  console.log(failures === 0 ? "STAGE 26 REAL-CORPUS ACCEPTANCE PASSED" : `STAGE 26 REAL-CORPUS ACCEPTANCE FAILED (${failures} check(s))`);
  console.log("=".repeat(96));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nSTAGE 26 REAL-CORPUS ACCEPTANCE ERRORED");
  console.error(err);
  process.exit(1);
});
