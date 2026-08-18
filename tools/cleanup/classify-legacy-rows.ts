/**
 * Stage 25B — Blocker 4. Reviewed classification of legacy rows that today's validators would
 * reject, plus an OPT-IN, REVERSIBLE quarantine for the two categories that are unambiguous.
 *
 * WHY THIS IS NOT A DELETE SCRIPT. Stage 25A's ingestion fixes are forward-looking: rows already in
 * the database were admitted by the older, weaker validators and stay there. Deleting them is
 * irreversible and, for two of the four categories below, not obviously correct — a malformed title
 * or a missing description does not prove the posting is not real. So this tool:
 *   - REPORTS by default and writes nothing;
 *   - quarantines only when explicitly asked, and only categories A and B;
 *   - quarantines by ARCHIVING (jobs.is_archived), which is the codebase's own reversible lifecycle
 *     state — archiveJob() also refuses to touch a job any candidate has pinned or has moved into a
 *     protected pipeline stage, and records the transition in job_status_history;
 *   - never deletes anything, ever. Permanent removal remains an explicit operator decision.
 *
 * Categories:
 *   A  definite navigation / non-job     — the title is exactly a navigation phrase, or the record
 *                                          fails the CURRENT validateNormalizedJob contract.
 *   B  definite non-US                   — classifyJobLocation() says NON_US, violating the
 *                                          configured US-only ingestion policy.
 *   C  malformed but possibly real       — title carries markup/newline/CSS artifacts. NOT
 *                                          quarantined: the underlying posting may be genuine.
 *   D  descriptionless career_link       — no description at all, so it can never be evaluated.
 *                                          NOT quarantined: it is a scraping-depth problem, and
 *                                          these rows already sort to the bottom of the feed.
 *
 * Usage, from the repository root:
 *   npx tsx tools/cleanup/classify-legacy-rows.ts                    # report only (default)
 *   npx tsx tools/cleanup/classify-legacy-rows.ts --samples 25       # more evidence per category
 *   npx tsx tools/cleanup/classify-legacy-rows.ts --quarantine A,B   # reversible archive of A and B
 */
import { getDb } from "../../src/db";
import { archiveJob } from "../../src/db/queries/jobs";
import { isRealJobPosting } from "../../src/lib/ats/jobValidation";
import { classifyJobLocation } from "../../src/lib/jobLocationScope";
import type { NormalizedJob } from "../../src/types";

type Category = "A" | "B" | "C" | "D";

const CATEGORY_LABEL: Record<Category, string> = {
  A: "definite navigation / non-job",
  B: "definite non-US (violates US-only ingestion policy)",
  C: "malformed title, potentially real job",
  D: "descriptionless career_link row",
};
const QUARANTINABLE: Category[] = ["A", "B"];

interface Row {
  id: number;
  source_type: string;
  title: string;
  url: string;
  location: string | null;
  description_text: string | null;
  external_id: string | null;
  department: string | null;
  employment_type: string | null;
  salary_text: string | null;
  posted_at: string | null;
  company_name: string;
}

interface Classified {
  row: Row;
  category: Category;
  reason: string;
}

function toNormalized(row: Row): NormalizedJob {
  return {
    externalId: row.external_id,
    title: row.title,
    location: row.location,
    department: row.department,
    url: row.url,
    descriptionHtml: null,
    descriptionText: row.description_text,
    employmentType: row.employment_type,
    workplaceType: null,
    salaryText: row.salary_text,
    postedAt: row.posted_at,
    raw: {},
  } as NormalizedJob;
}

function classify(row: Row): Classified | null {
  // A — rejected by the CURRENT validator contract (navigation titles, fragment-only URLs, ...).
  if (!isRealJobPosting(toNormalized(row))) {
    return { row, category: "A", reason: "fails validateNormalizedJob under the current contract" };
  }
  // B — explicit non-US evidence.
  if (classifyJobLocation(row.location) === "NON_US") {
    return { row, category: "B", reason: `classifyJobLocation() = NON_US for "${row.location ?? ""}"` };
  }
  // C — title artifacts from HTML scraping.
  if (/[\n{<]/.test(row.title) || /\.st\d|fill:none|^\s*$/.test(row.title)) {
    return { row, category: "C", reason: "title contains markup / newline / CSS artifacts" };
  }
  // D — career_link rows with nothing to evaluate.
  if (row.source_type === "career_link" && (!row.description_text || row.description_text.trim().length === 0)) {
    return { row, category: "D", reason: "career_link row with no description text" };
  }
  return null;
}

function main(): void {
  const args = process.argv.slice(2);
  const sampleFlag = args.find((a) => a.startsWith("--samples"));
  const sampleSize = sampleFlag ? Number(sampleFlag.split("=")[1] ?? args[args.indexOf(sampleFlag) + 1]) || 10 : 10;
  const quarantineFlag = args.find((a) => a.startsWith("--quarantine"));
  const quarantineArg = quarantineFlag ? quarantineFlag.split("=")[1] ?? args[args.indexOf(quarantineFlag) + 1] ?? "" : "";
  const quarantine = quarantineArg
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s): s is Category => (QUARANTINABLE as string[]).includes(s));

  if (quarantineArg && quarantine.length === 0) {
    console.error(`--quarantine accepts only ${QUARANTINABLE.join(",")} (C and D are never auto-quarantined).`);
    process.exitCode = 1;
    return;
  }

  const rows = getDb()
    .prepare(
      `SELECT j.id, j.source_type, j.title, j.url, j.location, j.description_text, j.external_id,
              j.department, j.employment_type, j.salary_text, j.posted_at, c.name AS company_name
         FROM jobs j JOIN companies c ON c.id = j.company_id
        WHERE j.is_active = 1 AND j.is_archived = 0
        ORDER BY j.id ASC`
    )
    .all() as Row[];

  const byCategory = new Map<Category, Classified[]>();
  for (const row of rows) {
    const hit = classify(row);
    if (!hit) continue;
    const list = byCategory.get(hit.category) ?? [];
    list.push(hit);
    byCategory.set(hit.category, list);
  }

  console.log("=".repeat(100));
  console.log("STAGE 25B — LEGACY ROW CLASSIFICATION (read-only unless --quarantine is passed)");
  console.log("=".repeat(100));
  console.log(`active + unarchived jobs scanned: ${rows.length}\n`);

  for (const category of ["A", "B", "C", "D"] as Category[]) {
    const list = byCategory.get(category) ?? [];
    const disposition = QUARANTINABLE.includes(category)
      ? quarantine.includes(category)
        ? "QUARANTINE (reversible archive)"
        : "eligible for quarantine — not requested"
      : "REPORT ONLY — never auto-quarantined";
    console.log(`-- ${category}. ${CATEGORY_LABEL[category]} —— ${list.length} row(s) —— ${disposition}`);
    const bySource = new Map<string, number>();
    for (const c of list) bySource.set(c.row.source_type, (bySource.get(c.row.source_type) ?? 0) + 1);
    if (bySource.size > 0) {
      console.log("   by source: " + [...bySource.entries()].sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s}=${n}`).join(", "));
    }
    for (const c of list.slice(0, sampleSize)) {
      console.log(
        `   job ${String(c.row.id).padStart(6)} | ${c.row.source_type.padEnd(14)} | ${c.row.company_name.slice(0, 26).padEnd(26)} | ` +
          `${JSON.stringify(c.row.title).slice(0, 44).padEnd(44)} | ${c.row.url.slice(0, 52)}`
      );
      console.log(`             reason: ${c.reason}`);
    }
    if (list.length > sampleSize) console.log(`   ... and ${list.length - sampleSize} more`);
    console.log("");
  }

  if (quarantine.length === 0) {
    console.log("No changes made. Re-run with --quarantine A,B to reversibly archive those categories.");
    return;
  }

  let archived = 0;
  let blocked = 0;
  for (const category of quarantine) {
    for (const c of byCategory.get(category) ?? []) {
      const result = archiveJob(c.row.id, `Stage 25B quarantine (${category}): ${c.reason}`);
      if (result.ok) archived++;
      else {
        blocked++;
        console.log(`   SKIPPED job ${c.row.id} — ${result.blockedReason}`);
      }
    }
  }
  console.log(`\nQuarantined (archived, reversible): ${archived}. Protected/skipped: ${blocked}.`);
  console.log("Nothing was deleted. To restore: UPDATE jobs SET is_archived = 0, archived_at = NULL, archived_reason = NULL WHERE id IN (...)");
}

main();
