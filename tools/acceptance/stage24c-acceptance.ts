/**
 * Stage 24C — native-Mac production acceptance report.
 *
 * READ-ONLY DIAGNOSTIC TOOLING. Not application code, not part of any production code path, and
 * never imported by src/. Nothing in this file writes: it issues SELECTs and PRAGMA-free reads
 * only, and it never mutates jobs, candidates, job_skills, job_match_results, candidate_job_state
 * or any other table. It makes no network calls and uses no paid provider — the single fetch() it
 * performs is to the operator's OWN locally-running dev server on 127.0.0.1:3000, and only when
 * --top20 is passed.
 *
 * ============================================================================================
 * RUN ORDER — THIS MATTERS. RUN IT ONLY AFTER, IN THIS EXACT SEQUENCE:
 *
 *     npm run extract-job-intel        # 1. re-extract structured job intelligence FIRST
 *     npm run rematch-candidate -- 1   # 2. only THEN drain evaluation
 *
 * Running the evaluation first re-scores the OLD extraction. Before Stage 24C's fix, a job
 * description saying "Databricks, Snowflake, or Redshift" was stored in job_skills as a standalone
 * Required "Databricks" PLUS a "Snowflake OR Redshift" alternative group — i.e. the candidate had
 * to possess Databricks AND one of the other two. Those wrong rows persist in the database until
 * re-extracted. EXTRACTION_VERSION 2 participating in the match knowledge hash then invalidates
 * every match result computed against them, so evaluating first simply means paying for the whole
 * pass twice and reading untrustworthy numbers in between.
 *
 * Section 1 below guards this explicitly: it counts active jobs still sitting below the current
 * EXTRACTION_VERSION and says so loudly rather than letting a stale run look successful.
 * ============================================================================================
 *
 * Usage, from the repository root:
 *     npx tsx tools/acceptance/stage24c-acceptance.ts            # Phase 5 items 1-14, Phase 6 A-D
 *     npx tsx tools/acceptance/stage24c-acceptance.ts --top20    # also item 15 (needs `npm run dev`)
 *
 * Expected versions after Stage 25A: MATCH_ENGINE_VERSION 4, EXTRACTION_VERSION 3.
 */
import { getDb, getDbPath } from "../../src/db";
import { MATCH_ENGINE_VERSION } from "../../src/lib/match/scoring";
import { EXTRACTION_VERSION } from "../../src/lib/jobIntel/extractJobIntel";
import { countJobsNeedingEvaluation } from "../../src/lib/match/autoEvaluate";

const CANDIDATE_ID = 1;
const EXPECTED_MATCH_ENGINE_VERSION = 4;
const EXPECTED_EXTRACTION_VERSION = 3;

const db = getDb();
const one = <T>(sql: string, ...params: unknown[]): T => db.prepare(sql).get(...params) as T;
const all = <T>(sql: string, ...params: unknown[]): T[] => db.prepare(sql).all(...params) as T[];
const count = (sql: string, ...params: unknown[]): number => one<{ c: number }>(sql, ...params).c;

/**
 * Latest active result per dedupe_key for this candidate, restricted to the LIVE corpus — exactly
 * the rows the UI reads.
 *
 * STAGE 25A — WHY THE `EXISTS` CLAUSE. Without it this view also returned results for dedupe_keys
 * that no longer belong to any job at all (10 orphaned rows on the real database, left behind by
 * jobs deleted by the age-based lifecycle sweep — job_match_results deliberately has no FK, see
 * ai_enrichments' "orphaned but harmless" note) and for ARCHIVED jobs (1,600 rows), neither of which
 * any view can display. That inflated "latest active results" to 19,677 against an 18,065-job live
 * corpus and made "results by engine version" read permanently MIXED. Worse, an orphaned row's
 * job_id column still points at whatever id it had when written — job_id is debug metadata and
 * dedupe_key is authoritative (schema.sql says so explicitly) — so any join through job_id
 * attributes a stale result to an unrelated live job.
 */
const LATEST = `
  SELECT r.* FROM job_match_results r
  JOIN (
    SELECT dedupe_key, MAX(id) AS id FROM job_match_results
    WHERE candidate_id = ? AND status = 'active' GROUP BY dedupe_key
  ) m ON m.id = r.id
  WHERE EXISTS (
    SELECT 1 FROM jobs j WHERE j.dedupe_key = r.dedupe_key AND j.is_active = 1 AND j.is_archived = 0
  )`;

const rule = () => console.log("=".repeat(96));

rule();
console.log("STAGE 24C — PRODUCTION ACCEPTANCE REPORT");
rule();
console.log("db path                  :", getDbPath());
console.log(
  "MATCH_ENGINE_VERSION     :", MATCH_ENGINE_VERSION,
  MATCH_ENGINE_VERSION === EXPECTED_MATCH_ENGINE_VERSION ? "OK" : `MISMATCH — expected ${EXPECTED_MATCH_ENGINE_VERSION}`
);
console.log(
  "EXTRACTION_VERSION       :", EXTRACTION_VERSION,
  EXTRACTION_VERSION === EXPECTED_EXTRACTION_VERSION ? "OK" : `MISMATCH — expected ${EXPECTED_EXTRACTION_VERSION}`
);

// --- 1. corpus + the re-extraction guard -------------------------------------------------------
const totalJobs = count("SELECT COUNT(*) c FROM jobs");
const activeJobs = count("SELECT COUNT(*) c FROM jobs WHERE is_active = 1 AND is_archived = 0");
const notReExtracted = count(
  `SELECT COUNT(*) c FROM jobs
    WHERE is_active = 1 AND is_archived = 0
      AND (structured_extraction_version IS NULL OR structured_extraction_version < ?)`,
  EXTRACTION_VERSION
);
console.log("\n-- 1. corpus ---------------------------------------------------------------------------");
console.log("jobs (all / active+unarchived):", totalJobs, "/", activeJobs);
console.log(
  `active jobs NOT yet re-extracted at v${EXTRACTION_VERSION}:`, notReExtracted,
  notReExtracted === 0
    ? "OK — re-extraction complete"
    : "!! STOP — run `npm run extract-job-intel` first; every number below is computed against stale requirement units"
);

// --- 2/3. evaluation backlog -------------------------------------------------------------------
console.log("\n-- 2/3. evaluation backlog -------------------------------------------------------------");
let backlog = "n/a";
try {
  backlog = String(countJobsNeedingEvaluation(CANDIDATE_ID));
} catch (err) {
  backlog = "ERR " + (err instanceof Error ? err.message : String(err));
}
console.log(
  "backlog NOW              :", backlog,
  backlog === "0" ? "OK — drained (item 3)" : "not drained — run `npm run rematch-candidate -- 1` again (item 2)"
);

// --- 4/5. evaluations + errors -----------------------------------------------------------------
const latestRows = all<{ match_engine_version: number }>(LATEST, CANDIDATE_ID);
const byVersion = new Map<number, number>();
for (const row of latestRows) byVersion.set(row.match_engine_version, (byVersion.get(row.match_engine_version) ?? 0) + 1);
console.log("\n-- 4/5. evaluations --------------------------------------------------------------------");
console.log("latest active results    :", latestRows.length);
console.log(
  "results by engine version:", JSON.stringify(Object.fromEntries(byVersion)),
  byVersion.size === 1 && byVersion.has(EXPECTED_MATCH_ENGINE_VERSION) ? "OK — all at v4" : "MIXED — re-evaluation incomplete"
);
console.log("errors                   : (report the `errored` count printed by rematch-candidate — not persisted in the DB)");

// --- 6. score distribution ---------------------------------------------------------------------
console.log("\n-- 6. score distribution (evidenced rows only; insufficient-signal excluded) ------------");
const bands = all<{ band: string; c: number }>(
  `SELECT CASE
     WHEN overall_score >= 85 THEN '85-100 very strong'
     WHEN overall_score >= 70 THEN '70-84  credible'
     WHEN overall_score >= 50 THEN '50-69  meaningful gaps'
     ELSE '0-49   weak' END AS band,
   COUNT(*) c FROM (${LATEST}) WHERE insufficient_jd_signal = 0 GROUP BY band ORDER BY band DESC`,
  CANDIDATE_ID
);
for (const b of bands) console.log("  " + b.band.padEnd(24), String(b.c).padStart(7));
if (bands.length === 0) console.log("  (none)");

// --- 7/8/9. decision distribution ---------------------------------------------------------------
console.log("\n-- 7/8/9. decision distribution --------------------------------------------------------");
const decisions = all<{ decision: string; c: number }>(
  `SELECT decision, COUNT(*) c FROM (${LATEST}) GROUP BY decision ORDER BY c DESC`,
  CANDIDATE_ID
);
for (const d of decisions) console.log("  " + d.decision.padEnd(24), String(d.c).padStart(7));
const readyCount = decisions.find((d) => d.decision === "READY_FOR_TAILORING")?.c ?? 0;

// --- 10/11/12. eligibility distribution ---------------------------------------------------------
console.log("\n-- 10/11/12. eligibility distribution --------------------------------------------------");
const eligibility = all<{ eligibility_status: string; c: number }>(
  `SELECT eligibility_status, COUNT(*) c FROM (${LATEST}) GROUP BY eligibility_status ORDER BY c DESC`,
  CANDIDATE_ID
);
for (const e of eligibility) console.log("  " + e.eligibility_status.padEnd(24), String(e.c).padStart(7));

// --- invariants that must hold regardless of corpus ---------------------------------------------
const blockedReady = count(
  `SELECT COUNT(*) c FROM (${LATEST}) WHERE eligibility_status = 'BLOCKED' AND decision = 'READY_FOR_TAILORING'`,
  CANDIDATE_ID
);
const unknownReady = count(
  `SELECT COUNT(*) c FROM (${LATEST}) WHERE eligibility_status = 'UNKNOWN' AND decision = 'READY_FOR_TAILORING'`,
  CANDIDATE_ID
);
console.log("\n-- invariants --------------------------------------------------------------------------");
console.log("BLOCKED + READY          :", blockedReady, blockedReady === 0 ? "OK (must be 0 — hard blockers are absolute)" : "!! VIOLATION");
console.log("UNKNOWN + READY          :", unknownReady, "(expected > 0 — UNKNOWN sponsorship is advisory, never a silent veto)");

// --- 13/14. signal quality -----------------------------------------------------------------------
const insufficient = count(`SELECT COUNT(*) c FROM (${LATEST}) WHERE insufficient_jd_signal = 1`, CANDIDATE_ID);
const at100 = count(`SELECT COUNT(*) c FROM (${LATEST}) WHERE overall_score >= 100`, CANDIDATE_ID);
const at100Insufficient = count(
  `SELECT COUNT(*) c FROM (${LATEST}) WHERE overall_score >= 100 AND insufficient_jd_signal = 1`,
  CANDIDATE_ID
);
console.log("\n-- 13/14. signal quality ---------------------------------------------------------------");
console.log(
  "insufficient-data rows   :", insufficient,
  `(${latestRows.length > 0 ? Math.round((insufficient / latestRows.length) * 100) : 0}% of evaluated)`
);
console.log("score = 100              :", at100, `(of which insufficient-signal: ${at100Insufficient})`);
console.log("READY_FOR_TAILORING      :", readyCount);

// --- Phase 6 A/B/C — OR-group grouping, proven on the REAL extracted rows -------------------------
console.log("\n-- Phase 6 A/B/C — 3+ member OR groups in the real corpus --------------------------------");
const orGroups = all<{ job_id: number; members: string; lvl: string }>(
  `SELECT job_id, GROUP_CONCAT(skill_name, ' OR ') members, MIN(requirement_level) lvl
     FROM job_skills WHERE alternative_group_id IS NOT NULL
    GROUP BY job_id, alternative_group_id HAVING COUNT(*) >= 3 LIMIT 12`
);
console.log(
  "3+ member OR groups found:", orGroups.length,
  orGroups.length > 0
    ? "OK — the Defect 1 fix is live in the data"
    : "NONE — either re-extraction has not run, or this corpus genuinely has no 3+ item OR lists"
);
for (const g of orGroups) console.log(`   job ${String(g.job_id).padStart(6)} [${g.lvl}] ${g.members}`);

// --- Phase 6 D — an Intern/Entry posting must not look like a Senior one --------------------------
console.log("\n-- Phase 6 D — Intern/Entry postings ----------------------------------------------------");
const juniorPostings = all<{ title: string; seniority: string; overall_score: number; decision: string; dimension_scores: string }>(
  `SELECT j.title, COALESCE(j.seniority, 'Unknown') seniority, r.overall_score, r.decision, r.dimension_scores
     FROM (${LATEST}) r JOIN jobs j ON j.dedupe_key = r.dedupe_key
    WHERE j.seniority IN ('Intern', 'Entry') ORDER BY r.overall_score DESC LIMIT 10`,
  CANDIDATE_ID
);
if (juniorPostings.length === 0) {
  console.log("   (no Intern/Entry postings in the active corpus — the rule is untestable on this data)");
}
for (const p of juniorPostings) {
  let seniorityDim = "?";
  try {
    seniorityDim = String((JSON.parse(p.dimension_scores) as { seniority: number | null }).seniority);
  } catch {
    seniorityDim = "unparseable";
  }
  console.log(
    `   ${String(Math.round(p.overall_score)).padStart(3)}  seniorityDim=${seniorityDim.padEnd(6)} ` +
    `${p.decision.padEnd(20)} [${p.seniority}] ${p.title}`
  );
}
const juniorReady = count(
  `SELECT COUNT(*) c FROM (${LATEST}) r JOIN jobs j ON j.dedupe_key = r.dedupe_key
    WHERE j.seniority IN ('Intern', 'Entry') AND r.decision = 'READY_FOR_TAILORING'`,
  CANDIDATE_ID
);
console.log("   Intern/Entry at READY  :", juniorReady, juniorReady === 0 ? "OK" : "!! investigate — an internship reached READY");

// --- 15. top 20, straight from the live ranking engine --------------------------------------------
interface ForYouApiMatch {
  decision?: string;
  overallScore?: number | null;
  requirementCoverage?: number | null;
  eligibilityStatus?: string;
  insufficientJdSignal?: boolean;
  dimensionScores?: { roleAlignment?: number | null; preferred?: number | null };
}
interface ForYouApiJob {
  title?: string;
  source_type?: string;
  company_name?: string;
  company?: { name?: string };
  match?: ForYouApiMatch;
  ranking?: { ageDays?: number };
}

/**
 * STAGE 25A — the response shape this reader expects. GET /api/candidates/[id]/for-you returns
 * `{ candidateId, preferences, bucketCounts, entries: [{ job, ranking }] }`. This block used to read
 * `body.jobs` and `job.match`, neither of which the route has ever returned, so item 15 silently
 * printed "(empty feed)" on a perfectly healthy server — a diagnostic that could only ever report
 * success-looking emptiness. Match facts live on `ranking` (decision/overallScore/
 * insufficientJdSignal), which is where the route puts them.
 */
interface ForYouApiEntry {
  job?: ForYouApiJob & { location?: string };
  ranking?: {
    decision?: string | null;
    overallScore?: number | null;
    insufficientJdSignal?: boolean | null;
    freshnessTier?: string;
    roleFamilyTier?: string;
  };
}

async function reportTop20(): Promise<void> {
  if (!process.argv.includes("--top20")) {
    console.log();
    rule();
    return;
  }
  console.log("\n-- 15. top 20 from the live ranking engine ----------------------------------------------");
  try {
    const response = await fetch(`http://127.0.0.1:3000/api/candidates/${CANDIDATE_ID}/for-you`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { entries?: ForYouApiEntry[] };
    const top = (body.entries ?? []).slice(0, 20);
    console.log("rk | score | decision            | freshness | roleFam   | source     | company — title");
    top.forEach((entry, index) => {
      const job = entry.job ?? {};
      const ranking = entry.ranking ?? {};
      const score = ranking.insufficientJdSignal
        ? "insuf"
        : ranking.overallScore == null
          ? " n/e "
          : String(Math.round(ranking.overallScore)).padStart(5);
      console.log(
        `${String(index + 1).padStart(2)} | ${score} | ${String(ranking.decision ?? "NOT_EVALUATED").padEnd(19)} | ` +
        `${String(ranking.freshnessTier ?? "-").padEnd(9)} | ${String(ranking.roleFamilyTier ?? "-").padEnd(9)} | ` +
        `${String(job.source_type ?? "-").padEnd(10)} | ${job.company_name ?? job.company?.name ?? "?"} — ${job.title ?? "?"}`
      );
    });
    if (top.length === 0) console.log("(empty feed)");
    console.log("\ndeterministic ranking reason (key order, src/lib/rank/forYou.ts):");
    console.log("  decision -> JD-evidence tier -> score band(10) -> role-family -> sponsorship ->");
    console.log("  exact score -> employer-evidenced share -> requirement coverage -> freshness -> posted_at -> id");
  } catch (err) {
    console.log(
      "could not reach the For You API:", err instanceof Error ? err.message : String(err),
      "— start `npm run dev` first"
    );
  }
  console.log();
  rule();
}

void reportTop20();
