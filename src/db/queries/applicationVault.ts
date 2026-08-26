import { getDb } from "@/db";
import { DEFAULT_POLICY, type AnswerSource, type QuestionType, type ReusePolicy, type Sensitivity } from "@/lib/apply/questionTypes";
import { normalizeQuestion } from "@/lib/apply/questionMatching";

/**
 * Reading and writing the Application Answer Vault.
 *
 * The raw wording a site used is never overwritten — every variant is recorded verbatim beside its
 * normalised form, so a mapping can always be audited against what was really on screen.
 */

export interface VaultQuestion {
  id: number;
  canonical_key: string;
  normalized_question: string;
  question_type: QuestionType;
  sensitivity: Sensitivity;
  reuse_policy: ReusePolicy;
}

export interface VaultAnswer {
  id: number;
  question_id: number;
  candidate_id: number;
  answer_value: string;
  answer_source: AnswerSource;
  approved_by_user: 0 | 1;
  auto_fill_allowed: 0 | 1;
  last_confirmed_at: string | null;
  updated_at: string;
}

/** Every observed wording, for the deterministic exact-match step. */
export function loadKnownVariants(): Map<string, { canonicalKey: string; type: QuestionType }> {
  const rows = getDb()
    .prepare(
      `SELECT v.normalized_text AS normalized, q.canonical_key AS key, q.question_type AS type
         FROM application_question_variants v
         JOIN application_questions q ON q.id = v.question_id`
    )
    .all() as { normalized: string; key: string; type: QuestionType }[];

  const map = new Map<string, { canonicalKey: string; type: QuestionType }>();
  for (const r of rows) map.set(r.normalized, { canonicalKey: r.key, type: r.type });
  return map;
}

/** Find or create the canonical question, then record this exact wording against it. */
export function recordQuestion(input: {
  canonicalKey: string;
  questionType: QuestionType;
  observedText: string;
  sourceAts?: string | null;
}): VaultQuestion {
  const db = getDb();
  const policy = DEFAULT_POLICY[input.questionType];
  const normalized = normalizeQuestion(input.observedText);

  db.prepare(
    `INSERT INTO application_questions (canonical_key, normalized_question, question_type, sensitivity, reuse_policy)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(canonical_key) DO UPDATE SET updated_at = datetime('now')`
  ).run(input.canonicalKey, normalized, policy.type, policy.sensitivity, policy.reusePolicy);

  const question = db
    .prepare("SELECT * FROM application_questions WHERE canonical_key = ?")
    .get(input.canonicalKey) as VaultQuestion;

  db.prepare(
    `INSERT INTO application_question_variants (question_id, observed_text, normalized_text, source_ats)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(question_id, normalized_text) DO UPDATE SET last_seen_at = datetime('now')`
  ).run(question.id, input.observedText, normalized, input.sourceAts ?? null);

  return question;
}

export function getAnswer(candidateId: number, canonicalKey: string): VaultAnswer | undefined {
  return getDb()
    .prepare(
      `SELECT a.* FROM application_answers a
         JOIN application_questions q ON q.id = a.question_id
        WHERE a.candidate_id = ? AND q.canonical_key = ?`
    )
    .get(candidateId, canonicalKey) as VaultAnswer | undefined;
}

/**
 * Save an answer.
 *
 * `autoFillAllowed` is a SEPARATE decision from approving the value, and defaults to false.
 * Approving an answer once is not consent to it being typed into every future form unattended.
 */
export function saveAnswer(input: {
  candidateId: number;
  canonicalKey: string;
  questionType: QuestionType;
  observedText: string;
  answerValue: string;
  answerSource: AnswerSource;
  approvedByUser: boolean;
  autoFillAllowed?: boolean;
  sourceAts?: string | null;
}): VaultAnswer {
  const question = recordQuestion({
    canonicalKey: input.canonicalKey,
    questionType: input.questionType,
    observedText: input.observedText,
    sourceAts: input.sourceAts,
  });

  /* Only a question whose policy actually permits unattended reuse may store the flag.
   *
   * Both other policies refuse it, for different reasons: `never_auto` covers protected questions,
   * which must never be filled unattended at all; `ask_each_time` covers salary, open-ended prose
   * and similar, which are confirmed on every use. resolveAnswer already declines to fill either,
   * so storing the flag would not have caused a wrong fill — but it would have recorded a
   * permission the system will never honour, and data that lies about itself is how a later change
   * starts honouring it by accident.
   *
   * The guard lives here rather than only at the call site so no future caller can route around it. */
  const policy = DEFAULT_POLICY[input.questionType];
  const autoAllowed =
    policy.reusePolicy === "auto_after_approval" && Boolean(input.autoFillAllowed) && input.approvedByUser;

  getDb()
    .prepare(
      `INSERT INTO application_answers
         (question_id, candidate_id, answer_value, answer_source, approved_by_user, auto_fill_allowed, last_confirmed_at, updated_at)
       VALUES (@qid, @cid, @value, @source, @approved, @auto, datetime('now'), datetime('now'))
       ON CONFLICT(question_id, candidate_id) DO UPDATE SET
         answer_value = excluded.answer_value,
         answer_source = excluded.answer_source,
         approved_by_user = excluded.approved_by_user,
         auto_fill_allowed = excluded.auto_fill_allowed,
         last_confirmed_at = excluded.last_confirmed_at,
         updated_at = excluded.updated_at`
    )
    .run({
      qid: question.id,
      cid: input.candidateId,
      value: input.answerValue,
      source: input.answerSource,
      approved: input.approvedByUser ? 1 : 0,
      auto: autoAllowed ? 1 : 0,
    });

  return getAnswer(input.candidateId, input.canonicalKey)!;
}

export function listAnswers(candidateId: number): (VaultAnswer & { canonical_key: string; question_type: QuestionType; sensitivity: Sensitivity })[] {
  return getDb()
    .prepare(
      `SELECT a.*, q.canonical_key, q.question_type, q.sensitivity
         FROM application_answers a
         JOIN application_questions q ON q.id = a.question_id
        WHERE a.candidate_id = ?
        ORDER BY q.question_type, q.canonical_key`
    )
    .all(candidateId) as never;
}

export interface AnswerMemoryRow {
  id: number;
  canonical_key: string;
  /** The most recently seen verbatim wording for this question — never the normalised text, which
   *  strips filler words and punctuation for matching and is unfit to show a candidate. */
  question_text: string;
  question_type: QuestionType;
  sensitivity: Sensitivity;
  reuse_policy: ReusePolicy;
  answer_value: string;
  answer_source: AnswerSource;
  approved_by_user: 0 | 1;
  auto_fill_allowed: 0 | 1;
  updated_at: string;
}

/**
 * UI-AM — the one candidate-facing read of the Answer Vault. Same table, same rows `listAnswers`
 * already returns; this only adds the one thing a candidate-facing list needs that the internal
 * fill-time reader never did: a real, human-readable question label. `normalized_question` (used
 * internally for exact-match lookups) is lowercased and stripped of filler words — showing it
 * verbatim would read as broken English, not a design choice, so this joins the most recently seen
 * `application_question_variants.observed_text` for the same question instead.
 */
export function listAnswersForCandidate(candidateId: number): AnswerMemoryRow[] {
  return getDb()
    .prepare(
      `SELECT
         a.id AS id,
         q.canonical_key AS canonical_key,
         COALESCE(
           (SELECT v.observed_text FROM application_question_variants v
             WHERE v.question_id = q.id ORDER BY v.last_seen_at DESC LIMIT 1),
           q.normalized_question
         ) AS question_text,
         q.question_type AS question_type,
         q.sensitivity AS sensitivity,
         q.reuse_policy AS reuse_policy,
         a.answer_value AS answer_value,
         a.answer_source AS answer_source,
         a.approved_by_user AS approved_by_user,
         a.auto_fill_allowed AS auto_fill_allowed,
         a.updated_at AS updated_at
       FROM application_answers a
       JOIN application_questions q ON q.id = a.question_id
      WHERE a.candidate_id = ?
      ORDER BY a.updated_at DESC`
    )
    .all(candidateId) as AnswerMemoryRow[];
}

/**
 * Edit an existing remembered answer's value and/or its auto-fill flag.
 *
 * REUSES `saveAnswer` — THE SAME WRITE PATH THE QUESTION CENTER ALREADY USES, not a second one.
 * Looked up by `answerId` (scoped to `candidateId`) rather than trusting a client-supplied
 * canonicalKey, so a candidate can only ever edit their own row. `saveAnswer`'s own policy guard
 * (only `auto_after_approval` types may ever actually get `auto_fill_allowed=1`) applies exactly as
 * it does from the Question Center — this cannot grant a type permission its policy refuses.
 */
export function editAnswer(
  candidateId: number,
  answerId: number,
  changes: { answerValue?: string; autoFillAllowed?: boolean }
): VaultAnswer | undefined {
  const existing = getDb()
    .prepare(
      `SELECT
         a.*,
         q.canonical_key AS canonical_key,
         q.question_type AS question_type,
         COALESCE(
           (SELECT v.observed_text FROM application_question_variants v
             WHERE v.question_id = q.id ORDER BY v.last_seen_at DESC LIMIT 1),
           q.normalized_question
         ) AS observed_text
         FROM application_answers a
         JOIN application_questions q ON q.id = a.question_id
        WHERE a.id = ? AND a.candidate_id = ?`
    )
    .get(answerId, candidateId) as
    | (VaultAnswer & { canonical_key: string; question_type: QuestionType; observed_text: string })
    | undefined;
  if (!existing) return undefined;

  return saveAnswer({
    candidateId,
    canonicalKey: existing.canonical_key,
    questionType: existing.question_type,
    /* The real, most-recently-observed wording — NOT the canonical key. recordQuestion()
     * (called inside saveAnswer) re-derives normalized_text from this and upserts it into
     * application_question_variants; passing anything but genuine question wording here would
     * write a fabricated "variant" into that table and corrupt future exact-match lookups. */
    observedText: existing.observed_text,
    answerValue: changes.answerValue ?? existing.answer_value,
    /* Editing is itself a deliberate act of confirming this value — the same standing the
     * Question Center's own save already carries. */
    answerSource: "USER_INTERVENTION",
    approvedByUser: true,
    autoFillAllowed: changes.autoFillAllowed ?? Boolean(existing.auto_fill_allowed),
  });
}
