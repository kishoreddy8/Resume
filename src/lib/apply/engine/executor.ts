import type { Page } from "playwright";
import { advanceRun, getRun, recordEvent, updateCheckpoint, type ApplicationRun } from "@/db/queries/applicationRuns";
import { discoverFields, COLLECT_CONTROLS_SCRIPT, type RawControl } from "../agent/fieldDiscovery";
import { planFields, firstBlocker } from "../agent/planFields";
import { detectBlocking, BLOCKING_STATUS } from "../agent/detectBlocking";
import { selectAdapter } from "../agent/selectAdapter";
import { buildFinalReview, readSubmissionOutcome, type FinalReview } from "../finalReview";
import type { AdapterContext, FieldPlan } from "../agent/types";
import type { StoredAnswer } from "../resolveAnswer";
import type { QuestionType } from "../questionTypes";
import { ApplicationBrowserRuntime, type BrowserSession } from "./browserRuntime";

/**
 * The execution loop: walk one ApplicationRun through the state machine, in a real browser.
 *
 * THIS MODULE DECIDES NOTHING. What a field is, whether it may be filled, what value to use, when
 * to stop — all of that is the planner, the vault and the blocking detector, each already built and
 * tested. The executor's whole job is sequencing: navigate, look, plan, act, checkpoint, and stop
 * the moment anything needs a human.
 *
 * CHECKPOINT AFTER EVERY ACTION. Each filled field updates the persisted checkpoint, so a crash,
 * a refresh or a restart loses at most the action in flight. Resuming re-opens the page and
 * re-plans; already-persisted answers come back from the vault, not from a pretence that the old
 * browser session survived.
 *
 * THE LOOP CANNOT SUBMIT. Its terminal success state is READY_FOR_REVIEW. Submission lives in a
 * separate function that requires the caller to present an approval naming this exact run, and the
 * state machine underneath refuses the transition without it — two layers, either sufficient.
 */

export interface ExecutorDeps {
  context: AdapterContext;
  knownVariants: Map<string, { canonicalKey: string; type: QuestionType }>;
  storedAnswers: Map<string, StoredAnswer>;
}

export interface ExecutionCheckpoint {
  url: string | null;
  ats: string | null;
  step: "starting" | "navigating" | "filling" | "review" | "submitting";
  /** Selectors already acted on, with provenance. Values live in the review, never duplicated here. */
  completed: { selector: string; canonicalKey: string | null; source: string; kind: "fill" | "upload" }[];
  /** The review shown to the user, once built. It IS what the approval covers. */
  review?: FinalReview;
  lastAction: string;
}

const DEFAULT_SUBMIT = "#submit_application, button[type=submit]";

/** Read the signals detectBlocking needs from the live page. */
async function collectSignals(page: Page): Promise<{ url: string; text: string; markers: string[] }> {
  const [text, markers] = await Promise.all([
    page.evaluate(() => document.body?.innerText ?? ""),
    page.evaluate(() =>
      [...document.querySelectorAll("[class], iframe[src]")]
        .slice(0, 400)
        .map((el) => `${el.getAttribute("class") ?? ""} ${el.getAttribute("src") ?? ""}`)
    ),
  ]);
  return { url: page.url(), text, markers };
}

async function applyPlan(page: Page, plan: FieldPlan): Promise<void> {
  if (plan.action === "fill") {
    if (plan.field.kind === "select") {
      await page.selectOption(plan.field.selector, { label: plan.value });
    } else {
      await page.fill(plan.field.selector, plan.value);
    }
    return;
  }
  if (plan.action === "upload") {
    await page.setInputFiles(plan.field.selector, plan.filePath);
  }
}

/**
 * Run one application as far as it can safely go.
 *
 * Ends in a WAITING_* state (a human is needed), READY_FOR_REVIEW (filled, awaiting the user's
 * reading of it), or FAILED. Never SUBMITTED — see approveAndSubmit.
 */
export async function executeRun(
  runId: number,
  runtime: ApplicationBrowserRuntime,
  deps: ExecutorDeps
): Promise<ApplicationRun> {
  let run = getRun(runId);
  if (!run) throw new Error(`No application run ${runId}`);
  if (!run.apply_url) {
    return advanceRun(runId, "FAILED", { blockingReason: "This run has no application URL." });
  }
  /* Captured once: `run` is reassigned by every advanceRun below, which would lose the narrowing. */
  const applyUrl = run.apply_url;

  const adapter = selectAdapter({ source_type: (run.ats as never) ?? null, url: applyUrl });

  const checkpoint: ExecutionCheckpoint = {
    url: null,
    ats: run.ats,
    step: "starting",
    completed: [],
    lastAction: "run loaded",
  };

  /* A resumed run re-enters from a waiting state; a fresh one from QUEUED. Both re-open the page —
   * the browser that was here before is gone, and pretending otherwise is how state diverges. */
  if (run.status === "QUEUED") run = advanceRun(runId, "STARTING");

  let session: BrowserSession | null = null;
  try {
    session = await runtime.open(applyUrl);
    checkpoint.url = session.page.url();
    checkpoint.step = "navigating";
    checkpoint.lastAction = "opened application page";
    if (run.status === "STARTING") run = advanceRun(runId, "NAVIGATING", { checkpoint });
    else updateCheckpoint(runId, checkpoint);

    /* Blocking conditions before anything else: a CAPTCHA gates the whole page, and filling behind
     * one both fails and looks exactly like the automation the site is asking not to receive. */
    const signals = await collectSignals(session.page);
    const blocking = detectBlocking(signals);
    if (blocking) {
      recordEvent(runId, "blocking_detected", blocking);
      return advanceRun(runId, BLOCKING_STATUS[blocking], { checkpoint });
    }

    if (run.status !== "FILLING") run = advanceRun(runId, "FILLING", { checkpoint });
    checkpoint.step = "filling";

    const controls = (await session.page.evaluate(COLLECT_CONTROLS_SCRIPT)) as RawControl[];
    const fields = discoverFields(controls);
    const plans = planFields({
      fields,
      context: deps.context,
      knownVariants: deps.knownVariants,
      storedAnswers: deps.storedAnswers,
      selectorHints: adapter?.adapter.fieldSelectorHints(),
    });

    for (const plan of plans) {
      if (plan.action !== "fill" && plan.action !== "upload") continue;
      await applyPlan(session.page, plan);
      checkpoint.completed.push({
        selector: plan.field.selector,
        canonicalKey: plan.action === "fill" ? plan.canonicalKey : null,
        source: plan.source,
        kind: plan.action,
      });
      checkpoint.lastAction = `${plan.action}: ${plan.field.label ?? plan.field.selector}`;
      updateCheckpoint(runId, checkpoint);
      recordEvent(
        runId,
        plan.action === "upload" ? "document_uploaded" : "field_filled",
        plan.field.label ?? plan.field.selector
      );
    }

    /* The first unanswered question stops the run. The fields already filled are checkpointed, so
     * answering it resumes from here rather than starting over. */
    const blocker = firstBlocker(plans);
    if (blocker) {
      return advanceRun(runId, "WAITING_FOR_ANSWER", {
        checkpoint,
        blockingQuestion: blocker.question,
        blockingReason: blocker.reason,
      });
    }

    checkpoint.step = "review";
    checkpoint.review = buildFinalReview({
      company: null,
      role: "",
      ats: run.ats,
      plans,
      resumeFile: run.resume_file,
      coverLetterFile: run.cover_letter_file,
    });
    checkpoint.lastAction = "application filled; review built";
    return advanceRun(runId, "READY_FOR_REVIEW", { checkpoint });
  } catch (err) {
    /* Page content can leak into error messages; the stored reason stays generic and the detail
     * goes to the event log, which the run detail view exposes deliberately. */
    recordEvent(runId, "execution_error", String(err).slice(0, 300));
    return advanceRun(runId, "FAILED", { blockingReason: "The application run hit an error and stopped safely." });
  } finally {
    await session?.close();
  }
}

/**
 * The only path to a submitted application.
 *
 * Requires an approval naming this exact run — the storage layer refuses the transition otherwise —
 * and treats the click as a claim to verify, not a result. Only the page's own confirmation text
 * marks the run SUBMITTED; anything else is SUBMISSION_UNCONFIRMED and the user is asked to check.
 */
export async function approveAndSubmit(
  runId: number,
  runtime: ApplicationBrowserRuntime,
  approval: { runId: number },
  opts: { submitSelector?: string } = {}
): Promise<ApplicationRun> {
  let run = getRun(runId);
  if (!run) throw new Error(`No application run ${runId}`);
  if (!run.apply_url) return advanceRun(runId, "FAILED", { blockingReason: "This run has no application URL." });
  const applyUrl = run.apply_url;

  if (run.status === "READY_FOR_REVIEW") run = advanceRun(runId, "WAITING_FOR_SUBMIT_APPROVAL");
  run = advanceRun(runId, "SUBMITTING", { submitApproval: approval });

  let session: BrowserSession | null = null;
  try {
    session = await runtime.open(applyUrl);

    /* Refill from the approved review — a fresh page has empty fields, and the review the user
     * read IS the thing their approval covered. Only previously-completed selectors are touched;
     * nothing new is decided at submit time. */
    const checkpoint = run.checkpoint_json ? (JSON.parse(run.checkpoint_json) as ExecutionCheckpoint) : null;
    if (checkpoint?.review) {
      const controls = (await session.page.evaluate(COLLECT_CONTROLS_SCRIPT)) as RawControl[];
      const fields = discoverFields(controls);
      for (const completed of checkpoint.completed) {
        const field = fields.find((f) => f.selector === completed.selector);
        if (!field) continue;
        if (completed.kind === "upload") {
          const doc = completed.selector.toLowerCase().includes("cover") ? run.cover_letter_file : run.resume_file;
          if (doc) await session.page.setInputFiles(field.selector, doc);
          continue;
        }
        const line = checkpoint.review.answers.find(
          (a) => a.question === (field.label ?? completed.canonicalKey ?? "")
        );
        if (line) {
          if (field.kind === "select") await session.page.selectOption(field.selector, { label: line.value });
          else await session.page.fill(field.selector, line.value);
        }
      }
    }

    await session.page.click(opts.submitSelector ?? DEFAULT_SUBMIT);
    await session.page.waitForTimeout(1500);

    const text = await session.page.evaluate(() => document.body?.innerText ?? "");
    const outcome = readSubmissionOutcome(text);
    recordEvent(runId, "submit_attempted", outcome.evidence);

    if (outcome.confirmed) {
      return advanceRun(runId, "SUBMITTED", { confirmationText: outcome.evidence });
    }
    return advanceRun(runId, "SUBMISSION_UNCONFIRMED", {
      blockingReason: "The submit was clicked but the site did not clearly confirm receipt. Please verify.",
    });
  } catch (err) {
    recordEvent(runId, "execution_error", String(err).slice(0, 300));
    return advanceRun(runId, "FAILED", {
      blockingReason: "Submission hit an error; the application may not have been sent.",
    });
  } finally {
    await session?.close();
  }
}
