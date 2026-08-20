import { getDb } from "@/db";

/**
 * How often each skill appears across the scanned job corpus.
 *
 * WHAT THIS IS NOT: market demand. There is no external labour-market dataset anywhere in
 * Career-Ops, and this number is a count over whatever postings this instance happens to have
 * scraped — biased by which companies are configured, which connectors are healthy, and how long
 * the scanner has been running. Calling it "demand" would dress a corpus artefact up as an
 * economic fact. Every caller must label it as a search signal and say what it is counted over.
 *
 * ADDITIVE AND READ-ONLY. New query, new file; it changes no existing projection and touches no
 * existing route. `idx_job_skills_name` already covers the grouping, and the table is ~7k rows, so
 * the whole aggregate measured 50ms.
 */
export interface SkillSignalRow {
  skillName: string;
  /** Distinct jobs mentioning the skill — not row count, so an OR-group cannot double-count. */
  jobCount: number;
  /** How many of those mentions were marked Required rather than Preferred. */
  requiredCount: number;
}

export function getJobSkillSignal(): SkillSignalRow[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT skill_name AS skillName,
              COUNT(DISTINCT job_id) AS jobCount,
              SUM(CASE WHEN requirement_level = 'Required' THEN 1 ELSE 0 END) AS requiredCount
         FROM job_skills
        GROUP BY skill_name
        ORDER BY jobCount DESC`
    )
    .all() as SkillSignalRow[];
  return rows;
}

/** Total distinct jobs that contributed any skill row — the denominator a share would need. */
export function getJobSkillCorpusSize(): number {
  const db = getDb();
  const row = db.prepare(`SELECT COUNT(DISTINCT job_id) AS n FROM job_skills`).get() as { n: number };
  return row?.n ?? 0;
}
