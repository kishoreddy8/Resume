import { getDb } from "../src/db/index";
import { recordDiscoveryResult, resetConnectorFailureState } from "../src/db/queries/companies";
import { reconstructCanonicalUrl } from "../src/lib/ats/sourceRediscovery";
import type { Company, SourceType } from "../src/types";

/**
 * Discovery Parser Hardening + Known Stale Source Repair — a small, explicit, idempotent manifest
 * of 7 independently-verified token corrections (see the task's own audit evidence). Deliberately
 * NOT a general-purpose repair tool: every entry is hand-verified and hardcoded, exactly the "narrowly
 * scoped repair script" the task asks for rather than a mechanism that could silently apply to
 * companies nobody has actually verified.
 *
 * Reuses recordDiscoveryResult (the SAME function the real discovery pipeline calls on every VERIFIED
 * result) so the job_sources sync — including its existing, tested "identity changed -> review_status
 * resets to PENDING" rule (organizationRegistryCore.ts) — runs exactly the same way it would for any
 * other discovery result. No one-off UPDATE statements, no bespoke job_sources handling.
 *
 * Safe to run twice: a company already at its target state is a no-op, not an error. A company whose
 * CURRENT state matches neither the expected old state nor the target state aborts that one company's
 * repair (never overwrites unexpected data) without touching the other 6.
 *
 * Usage:
 *   npx tsx scripts/repair-known-stale-sources.ts            # dry run — prints before/after only
 *   npx tsx scripts/repair-known-stale-sources.ts --apply    # writes the repairs
 */

interface RepairEntry {
  companyId: number;
  companyName: string;
  expectedOldSourceType: Exclude<SourceType, "career_link">;
  expectedOldToken: string;
  newSourceType: Exclude<SourceType, "career_link">;
  newToken: string;
}

const REPAIRS: RepairEntry[] = [
  {
    companyId: 94,
    companyName: "Inovalon, Inc.",
    expectedOldSourceType: "greenhouse",
    expectedOldToken: "embed",
    newSourceType: "greenhouse",
    newToken: "inovalon",
  },
  {
    companyId: 1541,
    companyName: "Fetch, Inc.",
    expectedOldSourceType: "greenhouse",
    expectedOldToken: "fetchrewards",
    newSourceType: "greenhouse",
    newToken: "fetch",
  },
  {
    companyId: 2392,
    companyName: "Gilead Sciences, Inc.",
    expectedOldSourceType: "workday",
    expectedOldToken: "gilead|wd1|gileadcareers&quot;,&quot;intendedAudience&quot;:&quot;patient",
    newSourceType: "workday",
    newToken: "gilead|wd1|gileadcareers",
  },
  {
    companyId: 186,
    companyName: "Chegg, Inc.",
    expectedOldSourceType: "workday",
    expectedOldToken: "osv-chegg|wd5|Chegg",
    newSourceType: "workday",
    newToken: "chegg|wd5|Chegg",
  },
  {
    companyId: 436,
    companyName: "A10 Networks, Inc.",
    expectedOldSourceType: "workday",
    expectedOldToken: "osv-a10networks|wd503|A10CareerSite",
    newSourceType: "workday",
    newToken: "a10networks|wd503|A10CareerSite",
  },
  {
    companyId: 1062,
    companyName: "Bioventus, LLC.",
    expectedOldSourceType: "workday",
    expectedOldToken: "osv-bioventus|wd501|External",
    newSourceType: "workday",
    newToken: "bioventus|wd501|External",
  },
  {
    companyId: 553,
    companyName: "Dynata, LLC",
    expectedOldSourceType: "workday",
    expectedOldToken: "dynata|wd1|careers",
    newSourceType: "workday",
    newToken: "dynata|wd1|Dynata_Careers",
  },
];

function main() {
  const apply = process.argv.includes("--apply");
  const db = getDb();
  const getCompany = db.prepare("SELECT * FROM companies WHERE id = ?");

  console.log(`Known Stale Source Repair — ${apply ? "APPLY MODE (writing changes)" : "DRY RUN (pass --apply to write)"}\n`);

  let repaired = 0;
  let alreadyDone = 0;
  let aborted = 0;

  for (const entry of REPAIRS) {
    const company = getCompany.get(entry.companyId) as Company | undefined;
    console.log(`── ${entry.companyName} (company id ${entry.companyId}) ──`);
    if (!company) {
      console.log(`  ABORTED: company ${entry.companyId} not found`);
      aborted++;
      continue;
    }
    if (company.name !== entry.companyName) {
      console.log(`  ABORTED: name mismatch — expected "${entry.companyName}", found "${company.name}"`);
      aborted++;
      continue;
    }

    const isAtTarget = company.source_type === entry.newSourceType && company.ats_board_token === entry.newToken;
    const isAtExpectedOld = company.source_type === entry.expectedOldSourceType && company.ats_board_token === entry.expectedOldToken;

    console.log(`  BEFORE: ${company.source_type} / ${company.ats_board_token}`);
    console.log(`  AFTER:  ${entry.newSourceType} / ${entry.newToken}`);

    if (isAtTarget) {
      console.log(`  STATUS: already repaired — no-op (idempotent re-run)`);
      alreadyDone++;
      continue;
    }
    if (!isAtExpectedOld) {
      console.log(`  ABORTED: current state matches neither the expected old state nor the target state — refusing to overwrite unexpected data`);
      aborted++;
      continue;
    }
    if (!apply) {
      console.log(`  STATUS: would repair (dry run)`);
      continue;
    }

    const canonicalUrl = reconstructCanonicalUrl(entry.newSourceType, entry.newToken);
    if (!canonicalUrl) {
      console.log(`  ABORTED: could not reconstruct a canonical URL for the verified new token`);
      aborted++;
      continue;
    }

    recordDiscoveryResult(entry.companyId, {
      status: "VERIFIED",
      sourceType: entry.newSourceType,
      atsBoardToken: entry.newToken,
      discoveredJobsUrl: canonicalUrl,
      reason:
        `Verified manual repair (Discovery Parser Hardening + Known Stale Source Repair) — ` +
        `corrected from ${entry.expectedOldSourceType}/${entry.expectedOldToken}`,
      suspectedAts: null,
    });
    resetConnectorFailureState(
      entry.companyId,
      `Token repaired via verified manual audit (was: ${entry.expectedOldToken})`
    );
    console.log(`  STATUS: REPAIRED`);
    repaired++;
  }

  console.log(`\nDone: ${repaired} repaired, ${alreadyDone} already done, ${aborted} aborted, ${REPAIRS.length - repaired - alreadyDone - aborted} would-repair (dry run).`);
  if (!apply) {
    console.log("This was a DRY RUN — no production data was changed. Re-run with --apply to write.");
  }
}

main();
