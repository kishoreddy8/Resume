/**
 * Career-Ops Live Benchmark Runner — controlled A/B quality measurement.
 *
 * Creates a FRESH resume quality workflow from an existing tailoring run and invokes
 * processOneWorkflow directly. This avoids runtime_contract.json version mismatch issues
 * that arise when reusing workflows created under a prior git commit.
 *
 * Usage (from project root):
 *   npm run benchmark-writer -- --run=14 --label=CONTROL_BASELINE
 *   npm run benchmark-writer -- --run=14 --label=COMPACT_NOTES
 *   npm run benchmark-writer -- --run=14 --label=EFFORT_MEDIUM --effort=medium
 *
 * --run=<tailoring_run_id>  Which tailoring run to base the fresh workflow on
 * --label=<text>            Human label for this run
 * --effort=<level>          Optional: medium, high, xhigh (only if Phase 7 is active)
 */

import Database from "better-sqlite3";
import path from "path";

async function main(): Promise<void> {
  const PROJECT_ROOT = process.cwd();

  // Parse args
  const args: Record<string, string> = {};
  for (const a of process.argv.slice(2)) {
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > -1) {
        args[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        args[a.slice(2)] = "true";
      }
    }
  }

  const tailoringRunId = parseInt(args["run"] ?? "", 10);
  const label = args["label"] ?? "RUN";
  const effortLevel = args["effort"]; // undefined = don't pass --effort

  if (!tailoringRunId || isNaN(tailoringRunId)) {
    console.error("Usage: npm run benchmark-writer -- --run=<tailoring_run_id> [--label=LABEL] [--effort=medium]");
    console.error("");
    console.error("Available tailoring runs:");
    const db = new Database(path.join(PROJECT_ROOT, "data/app.db"));
    const runs = db.prepare("SELECT tr.id, tr.candidate_id, tr.dedupe_key, tr.recommended_track, a.id as app_id FROM tailoring_runs tr LEFT JOIN candidate_job_state a ON a.dedupe_key = tr.dedupe_key AND a.candidate_id = tr.candidate_id ORDER BY tr.id DESC LIMIT 10").all() as Record<string, unknown>[];
    for (const r of runs) console.error(`  --run=${r["id"]}  C${r["candidate_id"]} ${r["dedupe_key"]} [${r["recommended_track"]}]`);
    process.exit(1);
  }

  const db = new Database(path.join(PROJECT_ROOT, "data/app.db"));
  const tr = db.prepare("SELECT * FROM tailoring_runs WHERE id = ?").get(tailoringRunId) as Record<string, unknown> | undefined;
  if (!tr) { console.error(`Tailoring run ${tailoringRunId} not found.`); process.exit(1); }

  // Resolve application_id from candidate_job_state
  const appRow = db.prepare("SELECT id FROM candidate_job_state WHERE candidate_id = ? AND dedupe_key = ?").get(tr["candidate_id"], tr["dedupe_key"]) as Record<string, unknown> | undefined;
  if (!appRow) { console.error(`No candidate_job_state found for C${tr["candidate_id"]} + ${tr["dedupe_key"]}`); process.exit(1); }

  const candidateId = tr["candidate_id"] as number;
  const applicationId = appRow["id"] as number;
  const dedupeKey = tr["dedupe_key"] as string;

  console.log(`\n${"=".repeat(60)}`);
  console.log(`CAREER-OPS BENCHMARK: ${label}`);
  console.log(`${"=".repeat(60)}`);
  console.log(`Tailoring run : ${tailoringRunId}`);
  console.log(`Candidate     : ${candidateId}`);
  console.log(`Application   : ${applicationId}`);
  console.log(`Dedupe key    : ${dedupeKey}`);
  console.log(`Track         : ${tr["recommended_track"]}`);
  console.log(`Effort        : ${effortLevel ?? "(default — CLI default reasoning)"}`);
  console.log(`Started       : ${new Date().toISOString()}`);
  console.log(`${"=".repeat(60)}`);

  // Create a fresh workflow (CREATED status, fresh workspace — no runtime_contract.json)
  const { createResumeQualityWorkflow } = await import("@/db/queries/resumeQualityWorkflows");
  const freshWf = createResumeQualityWorkflow({
    candidateId,
    applicationId,
    tailoringRunId,
    dedupeKey,
    maxIterations: 2,
  });

  console.log(`\n[WORKFLOW] Created fresh WF ${freshWf.id} (status: ${freshWf.status}, iteration: ${freshWf.current_iteration})`);

  // Transition to IMPROVEMENT_RUNNING so processOneWorkflow will pick it up
  // (createResumeQualityWorkflow creates it in CREATED, which is valid for pickup)
  const { processOneWorkflow } = await import("@/lib/resumeQuality/writers/writerWorkerCore");

  // Build cliOptions
  const cliOptions: Record<string, unknown> = {};
  if (effortLevel) {
    console.log(`\n[EFFORT] --effort=${effortLevel} will be passed if ClaudeCliInvokeOptions supports it.`);
    cliOptions["effort"] = effortLevel;
  }

  console.log(`\nInvoking processOneWorkflow for WF ${freshWf.id}...`);
  const t0 = Date.now();

  const outcome = await processOneWorkflow(freshWf, { cliOptions: cliOptions as never });

  const total = Date.now() - t0;

  console.log(`\n${"=".repeat(60)}`);
  console.log(`OUTCOME       : ${outcome.outcome}`);
  console.log(`Workflow ID   : ${freshWf.id}`);
  console.log(`Total wall    : ${(total / 1000).toFixed(1)}s (${(total / 60000).toFixed(2)} min)`);

  if (outcome.timings) {
    const t = outcome.timings;
    console.log(`\n--- Timings ---`);
    console.log(`  Export        : ${t.exportMs}ms`);
    console.log(`  Claude (wall) : ${(t.claudeMs / 1000).toFixed(1)}s (${(t.claudeMs / 60000).toFixed(2)} min)`);
    console.log(`  Import        : ${t.importMs}ms`);
    console.log(`  Review+Render : ${t.reviewAndRenderMs}ms`);
    console.log(`  Prompt bytes  : ${t.promptBytes ?? "??"}`);
    console.log(`  Output bytes  : ${t.outputBytes ?? "??"}`);
  }

  if (outcome.error) {
    console.log(`\nError         : ${outcome.error}`);
  }

  // Pull final quality scores
  const freshDb = new Database(path.join(PROJECT_ROOT, "data/app.db"));
  const iters = freshDb
    .prepare("SELECT * FROM resume_quality_iterations WHERE workflow_id = ? ORDER BY iteration_number DESC LIMIT 1")
    .all(freshWf.id) as Record<string, unknown>[];

  if (iters.length > 0) {
    const it = iters[0];
    console.log(`\n--- Quality Scores (Iteration ${it["iteration_number"]}) ---`);
    console.log(`  Overall      : ${it["overall_score"]}`);
    console.log(`  Truthfulness : ${it["truthfulness_score"]}`);
    console.log(`  ATS          : ${it["ats_score"]}`);
    console.log(`  Architecture : ${it["architecture_consistency_score"]}`);
    console.log(`  RecruiterRd  : ${it["recruiter_readability_score"]}`);
    console.log(`  Formatting   : ${it["formatting_score"]}`);
    console.log(`  Keyword Algn : ${it["keyword_alignment_score"]}`);
    console.log(`  Blocking     : ${it["blocking_issue_count"]}`);
  } else {
    console.log(`\nNo iteration rows found — check outcome.error above.`);
  }

  const updatedWf = freshDb
    .prepare("SELECT writer_model, status FROM resume_quality_workflows WHERE id = ?")
    .get(freshWf.id) as Record<string, unknown>;
  console.log(`\n--- Metadata ---`);
  console.log(`  Writer model  : ${updatedWf?.["writer_model"] ?? "?"}`);
  console.log(`  WF status     : ${updatedWf?.["status"] ?? "?"}`);
  console.log(`  Finished      : ${new Date().toISOString()}`);
  console.log(`${"=".repeat(60)}\n`);
}

main().catch((error) => {
  console.error("Benchmark runner failed:", error);
  process.exit(1);
});
