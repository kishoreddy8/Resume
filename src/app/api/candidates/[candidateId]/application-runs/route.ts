import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireActiveCandidate } from "@/db/queries/candidates";
import { requireCandidateAccess } from "@/lib/auth/guard";
import { getJob } from "@/db/queries/jobs";
import { getCompany } from "@/db/queries/companies";
import { advanceRun, getRun, listEvents, listRuns, listWaitingRuns, recordEvent } from "@/db/queries/applicationRuns";
import { WAITING_PROMPT, type RunStatus } from "@/lib/apply/runState";
import { loadKnownVariants, getAnswer, saveAnswer } from "@/db/queries/applicationVault";
import { matchQuestion } from "@/lib/apply/questionMatching";
import { resolveAnswer } from "@/lib/apply/resolveAnswer";
import { DEFAULT_POLICY } from "@/lib/apply/questionTypes";

/**
 * The Needs Your Input inbox.
 *
 * GET lists runs stopped and waiting on the user, each with what it is actually asking for. POST
 * answers one of them and resumes it.
 *
 * READ-ONLY UNTIL THE USER ACTS. Nothing here starts a browser, and nothing submits: the only
 * transitions this route can make are answering a question and resuming, or cancelling. Submission
 * lives behind its own explicit approval.
 */

export async function GET(req: NextRequest, ctx: { params: Promise<{ candidateId: string }> }) {
  const { candidateId: raw } = await ctx.params;
  const candidateId = Number(raw);
  if (!Number.isInteger(candidateId) || candidateId <= 0) {
    return NextResponse.json({ error: "Invalid candidate id" }, { status: 400 });
  }
  if (!requireActiveCandidate(candidateId)) return NextResponse.json({ error: "Not an active candidate" }, { status: 404 });
  const denial = requireCandidateAccess(req, candidateId);
  if (denial) return denial;

  /* ── one run, in full ────────────────────────────────────────────────────────────────────────
   * Detail is fetched per run and never for a list. The timeline can be dozens of events and the
   * checkpoint carries the whole review; loading both for every row would make the list page pay
   * for detail nobody has opened yet. */
  const runIdParam = req.nextUrl.searchParams.get("runId");
  if (runIdParam) {
    const run = getRun(Number(runIdParam));
    if (!run || run.candidate_id !== candidateId) {
      return NextResponse.json({ error: "Application run not found" }, { status: 404 });
    }
    const job = getJob(run.job_id);
    const company = job?.company_id ? getCompany(job.company_id)?.name ?? null : null;
    /* The checkpoint holds the review the user must read before approving. Parsed here so the
     * client never has to know the checkpoint's internal shape. */
    let review: unknown = null;
    let humanQuestions: unknown = null;
    try {
      const cp = run.checkpoint_json ? (JSON.parse(run.checkpoint_json) as { review?: unknown; humanQuestions?: unknown }) : null;
      review = cp?.review ?? null;
      humanQuestions = cp?.humanQuestions ?? null;
    } catch {
      review = null;
    }
    return NextResponse.json({
      run: {
        id: run.id,
        jobId: run.job_id,
        title: job?.title ?? "(job no longer available)",
        company,
        location: job?.location ?? null,
        ats: run.ats,
        applyUrl: run.apply_url,
        status: run.status,
        prompt: WAITING_PROMPT[run.status as RunStatus] ?? null,
        blockingReason: run.blocking_reason,
        question: run.blocking_question,
        resumeFile: run.resume_file,
        coverLetterFile: run.cover_letter_file,
        submitApprovedAt: run.submit_approved_at,
        submittedAt: run.submitted_at,
        confirmationText: run.confirmation_text,
        createdAt: run.created_at,
        updatedAt: run.updated_at,
      },
      review,
      humanQuestions,
      /* Recorded events only. A run with no history shows none rather than an invented start. */
      events: listEvents(run.id),
    });
  }

  /* ── every run, bounded ──────────────────────────────────────────────────────────────────────
   * A candidate accumulates one row per job they applied to, not per job evaluated, so this is
   * small by construction — and still capped, because "small by construction" is an argument that
   * stops being true exactly when someone stops checking. */
  if (req.nextUrl.searchParams.get("scope") === "all") {
    const limit = Math.min(Math.max(Number(req.nextUrl.searchParams.get("limit") ?? 50), 1), 200);
    const all = listRuns(candidateId, limit).map((run) => {
      const job = getJob(run.job_id);
      return {
        id: run.id,
        jobId: run.job_id,
        title: job?.title ?? "(job no longer available)",
        company: job?.company_id ? getCompany(job.company_id)?.name ?? null : null,
        location: job?.location ?? null,
        ats: run.ats,
        status: run.status,
        prompt: WAITING_PROMPT[run.status as RunStatus] ?? null,
        question: run.blocking_question,
        resumeFile: run.resume_file,
        submittedAt: run.submitted_at,
        updatedAt: run.updated_at,
      };
    });
    return NextResponse.json({ candidateId, runs: all, limit });
  }

  const runs = listWaitingRuns(candidateId).map((run) => {
    const job = getJob(run.job_id);
    const company = job?.company_id ? getCompany(job.company_id)?.name ?? null : null;

    /* If the run is stuck on a question, offer whatever the vault already holds — as a suggestion,
     * never as a decision. The user is the one answering. */
    let suggestion: { value: string; reason: string } | null = null;
    if (run.blocking_question) {
      const match = matchQuestion(run.blocking_question, loadKnownVariants());
      if (match) {
        const stored = getAnswer(candidateId, match.canonicalKey);
        const resolution = resolveAnswer(match.type, stored);
        if (resolution.action !== "ask") {
          suggestion = {
            value: resolution.value,
            reason: resolution.action === "suggest" ? resolution.reason : "Saved and approved for reuse.",
          };
        }
      }
    }

    return {
      id: run.id,
      jobId: run.job_id,
      title: job?.title ?? "(job no longer available)",
      company,
      ats: run.ats,
      status: run.status,
      prompt: WAITING_PROMPT[run.status as RunStatus] ?? "This application needs your attention.",
      blockingReason: run.blocking_reason,
      question: run.blocking_question,
      suggestion,
      updatedAt: run.updated_at,
    };
  });

  return NextResponse.json({ candidateId, runs });
}

const AnswerBody = z.object({
  runId: z.number().int().positive(),
  answer: z.string().trim().min(1).max(5000),
  /** Explicit, and separate from providing the answer. Defaults to false. */
  reuseForEquivalentQuestions: z.boolean().optional(),
});

const BatchAnswer = z.object({
  id: z.string().min(1),
  answer: z.string().trim().min(1).max(5000),
  reuseForEquivalentQuestions: z.boolean().optional(),
});

const BatchAnswerBody = z.object({
  runId: z.number().int().positive(),
  /** Batch of answers keyed by humanQuestion.id. Must cover all required questions. */
  answers: z.array(BatchAnswer).min(1),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ candidateId: string }> }) {
  const { candidateId: raw } = await ctx.params;
  const candidateId = Number(raw);
  if (!Number.isInteger(candidateId) || candidateId <= 0) {
    return NextResponse.json({ error: "Invalid candidate id" }, { status: 400 });
  }
  if (!requireActiveCandidate(candidateId)) return NextResponse.json({ error: "Not an active candidate" }, { status: 404 });
  const denial = requireCandidateAccess(req, candidateId);
  if (denial) return denial;

  const rawBody = await req.json().catch(() => null);

  /* ── batch answer path ───────────────────────────────────────────────────────────────────────
   * Detected by the presence of an `answers` array in the body. Validates all submitted answers
   * against the humanQuestions stored in the checkpoint, saves each to the vault, and advances
   * the run to FILLING so the caller can resume execution.
   *
   * NEVER submits the application. The state machine transition is WAITING_FOR_ANSWER → FILLING,
   * not FILLING → READY_FOR_REVIEW or beyond. */
  if (rawBody && typeof rawBody === "object" && "answers" in rawBody) {
    const batchParsed = BatchAnswerBody.safeParse(rawBody);
    if (!batchParsed.success) {
      return NextResponse.json({ error: "A runId and answers array are required." }, { status: 400 });
    }
    const { runId: batchRunId, answers } = batchParsed.data;
    const batchRun = getRun(batchRunId);
    if (!batchRun || batchRun.candidate_id !== candidateId) {
      return NextResponse.json({ error: "Application run not found" }, { status: 404 });
    }
    if (batchRun.status !== "WAITING_FOR_ANSWER") {
      return NextResponse.json({ error: "This run is not waiting for an answer." }, { status: 409 });
    }

    type StoredHumanQuestion = {
      id: string; label: string; canonicalKey: string | null; questionType: string | null;
      required: boolean; options: string[] | null;
    };
    let humanQuestions: StoredHumanQuestion[] = [];
    try {
      const cp = batchRun.checkpoint_json ? JSON.parse(batchRun.checkpoint_json) as { humanQuestions?: StoredHumanQuestion[] } : null;
      humanQuestions = cp?.humanQuestions ?? [];
    } catch { /* malformed checkpoint — treat as no humanQuestions */ }

    /* Validate: every required question must have a submitted answer. */
    const answerById = new Map(answers.map((a) => [a.id, a]));
    const unanswered = humanQuestions.filter((q) => q.required && !answerById.has(q.id));
    if (unanswered.length > 0) {
      return NextResponse.json(
        { error: "Missing answers for required questions.", missing: unanswered.map((q) => q.id) },
        { status: 400 }
      );
    }

    /* Validate: if a question has employer-provided options, the answer must be one of them. */
    for (const submitted of answers) {
      const question = humanQuestions.find((q) => q.id === submitted.id);
      if (question?.options && !question.options.includes(submitted.answer)) {
        return NextResponse.json(
          { error: `"${submitted.answer}" is not a valid option for "${question.label}".` },
          { status: 400 }
        );
      }
    }

    const knownVariants = loadKnownVariants();
    for (const submitted of answers) {
      const question = humanQuestions.find((q) => q.id === submitted.id);
      if (!question) continue;

      /* Re-match by label to get the freshest canonicalKey and type. Fall back to what the
       * checkpoint carried if matching fails (e.g. a newly added variant not yet in this DB). */
      const rematch = matchQuestion(question.label, knownVariants);
      const canonicalKey = rematch?.canonicalKey ?? question.canonicalKey;
      const questionType = (rematch?.type ?? question.questionType ?? "other") as import("@/lib/apply/questionTypes").QuestionType;
      if (!canonicalKey) continue; // unrecognised question — saved nowhere, but run continues

      const policy = DEFAULT_POLICY[questionType];
      saveAnswer({
        candidateId,
        canonicalKey,
        questionType,
        observedText: question.label,
        answerValue: submitted.answer,
        answerSource: "USER_INTERVENTION",
        approvedByUser: true,
        /* auto_fill_allowed only when explicitly opted in AND the policy permits reuse.
         * saveAnswer enforces this again internally — belt and braces. */
        autoFillAllowed: Boolean(submitted.reuseForEquivalentQuestions) && policy.reusePolicy === "auto_after_approval",
        sourceAts: batchRun.ats,
      });
    }

    recordEvent(batchRun.id, "user_intervention_completed", `batch: answered ${answers.length} question(s)`);
    const advanced = advanceRun(batchRun.id, "FILLING", { blockingReason: null, blockingQuestion: null });
    return NextResponse.json({ status: "resumed", run: { id: advanced.id, status: advanced.status } });
  }

  /* ── single answer path (legacy / combobox runtime failure) ─────────────────────────────────── */
  const parsed = AnswerBody.safeParse(rawBody);
  if (!parsed.success) return NextResponse.json({ error: "A runId and answer are required." }, { status: 400 });

  const run = getRun(parsed.data.runId);
  if (!run || run.candidate_id !== candidateId) {
    return NextResponse.json({ error: "Application run not found" }, { status: 404 });
  }
  if (run.status !== "WAITING_FOR_ANSWER" || !run.blocking_question) {
    return NextResponse.json({ error: "This run is not waiting for an answer." }, { status: 409 });
  }

  /* The user's answer is stored against the canonical question when one is recognised, so the next
   * form asking the same thing can offer it. An unrecognised question is still answered — it simply
   * teaches nothing, which is better than inventing a mapping. */
  const match = matchQuestion(run.blocking_question, loadKnownVariants());
  if (match) {
    const policy = DEFAULT_POLICY[match.type];
    saveAnswer({
      candidateId,
      canonicalKey: match.canonicalKey,
      questionType: match.type,
      observedText: run.blocking_question,
      answerValue: parsed.data.answer,
      answerSource: "USER_INTERVENTION",
      approvedByUser: true,
      /* Only when explicitly asked for, and never for a question whose policy forbids it. */
      autoFillAllowed: Boolean(parsed.data.reuseForEquivalentQuestions) && policy.reusePolicy === "auto_after_approval",
      sourceAts: run.ats,
    });
  }

  recordEvent(run.id, "user_intervention_completed", match ? `answered ${match.canonicalKey}` : "answered (unmapped question)");
  const resumed = advanceRun(run.id, "FILLING", { blockingReason: null, blockingQuestion: null });

  return NextResponse.json({
    status: "resumed",
    run: { id: resumed.id, status: resumed.status },
    learned: match ? { canonicalKey: match.canonicalKey, via: match.via } : null,
  });
}

/** One run's full event history, for the detail view. */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ candidateId: string }> }) {
  const { candidateId: raw } = await ctx.params;
  const candidateId = Number(raw);
  const denial = requireCandidateAccess(req, candidateId);
  if (denial) return denial;

  const body = (await req.json().catch(() => null)) as { runId?: number } | null;
  const run = body?.runId ? getRun(body.runId) : undefined;
  if (!run || run.candidate_id !== candidateId) {
    return NextResponse.json({ error: "Application run not found" }, { status: 404 });
  }
  return NextResponse.json({ run, events: listEvents(run.id) });
}
