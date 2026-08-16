import pLimit from "p-limit";
import { listDiscoveryV2Candidates } from "../src/db/queries/organizationRegistry";
import { createProposalFromDiscoveryV2, isProposalApprovable } from "../src/db/queries/atsSourceProposals";
import { discoverCompanySourceV2 } from "../src/lib/ats/discoveryV2";

/**
 * Discovery V2 — manual, bounded, SHADOW-ONLY runner.
 *
 * Renders a real headless browser page for each candidate company (UNRESOLVED/GENERIC_SUPPORTED,
 * zero active jobs — see listDiscoveryV2Candidates's own doc comment for the exact priority order),
 * collects every ATS signal from static HTML, network requests, iframes, and the redirect chain,
 * deduplicates into candidates, validates each with a real bounded sample fetch, and prints a
 * structured report.
 *
 * SHADOW MODE (default): this script NEVER writes to companies, job_sources, jobs, or any other
 * production table. It is a pure read (network I/O to render pages and validate candidates aside).
 * Nothing it finds is applied automatically.
 *
 * Stage 3 addition: --persist-proposals writes durable ats_source_proposals rows for every
 * structured candidate found (see createProposalFromDiscoveryV2's own dedup rules) — still never a
 * company/job_source/job write, and never an approval; a proposal only ever becomes an active source
 * through the separate, explicit approveProposal action (API/UI). Omitting the flag keeps behavior
 * byte-for-byte identical to Stage 2.
 *
 * NOT wired into the scheduler — deliberately manual, human-triggered, small batches.
 *
 * Usage: npm run discovery-v2-shadow -- --scope unresolved --limit 5
 *        npm run discovery-v2-shadow -- --scope unresolved --limit 5 --persist-proposals
 */
async function main() {
  const scopeIndex = process.argv.indexOf("--scope");
  const scopeArg = scopeIndex >= 0 ? process.argv[scopeIndex + 1] : "unresolved";
  if (scopeArg !== "unresolved" && scopeArg !== "generic" && scopeArg !== "both") {
    throw new Error("--scope must be one of: unresolved, generic, both");
  }

  const limitIndex = process.argv.indexOf("--limit");
  const requestedLimit = limitIndex >= 0 ? Number.parseInt(process.argv[limitIndex + 1] ?? "", 10) : 5;
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 25) {
    throw new Error("--limit must be an integer from 1 to 25 (default 5) — this is a manual, bounded shadow tool, not a bulk scan");
  }

  const persistProposals = process.argv.includes("--persist-proposals");

  const candidates = listDiscoveryV2Candidates(scopeArg, requestedLimit);
  if (candidates.length === 0) {
    console.log(`No ${scopeArg} zero-job companies currently match Discovery V2's eligibility criteria.`);
    return;
  }

  console.log(`Discovery V2 shadow run — ${candidates.length} compan${candidates.length === 1 ? "y" : "ies"} (scope=${scopeArg}, read-only, no mutation):\n`);

  const limit = pLimit(3); // bounded browser concurrency, per Phase 10's explicit 2-3 max
  const results = await Promise.all(
    candidates.map((company) =>
      limit(async () => {
        const seedUrl = company.career_page_url ?? company.discovered_jobs_url;
        if (!seedUrl) {
          return { company, result: null as Awaited<ReturnType<typeof discoverCompanySourceV2>> | null };
        }
        const result = await discoverCompanySourceV2(company, seedUrl);
        return { company, result };
      })
    )
  );

  for (const { company, result } of results) {
    console.log(`── ${company.name} (id ${company.id}) ──`);
    console.log(`  current status: ${company.resolution_status}`);
    console.log(`  career page: ${company.career_page_url ?? "(none on file)"}`);
    if (!result) {
      console.log(`  SKIPPED: no career_page_url or discovered_jobs_url to seed from\n`);
      continue;
    }
    console.log(`  pages visited: ${result.pagesVisited}`);
    console.log(`  seed final URL: ${result.seedFinalUrl ?? "(navigation did not complete)"}`);
    if (result.followedCareersUrl) {
      console.log(`  followed careers link: ${result.followedCareersUrl} (score=${result.careersLinkScore})`);
      console.log(`  followed final URL: ${result.followedFinalUrl ?? "(navigation did not complete)"}`);
    } else {
      console.log(`  followed careers link: (none — candidate found on seed, or no qualifying first-party link)`);
    }
    console.log(`  outcome: ${result.outcome} — ${result.reason}`);
    console.log(`  observed requests: ${result.observedRequestCount}, duration: ${result.durationMs}ms`);
    if (result.candidates.length === 0) {
      console.log(`  candidates: none`);
    }
    for (const candidate of result.candidates) {
      console.log(`  candidate: ${candidate.provider} / ${candidate.boardToken} (found on ${candidate.foundOnPage} page)`);
      console.log(`    evidence: ${candidate.evidenceTypes.join(", ")}`);
      console.log(`    validation: ${candidate.validationStatus} (jobsSeen=${candidate.jobsSeen})`);
      console.log(`    confidence: ${candidate.confidence}`);
      console.log(`    recommendation: ${candidate.recommendation}`);

      if (persistProposals) {
        const proposal = createProposalFromDiscoveryV2({
          companyId: company.id,
          currentSourceType: company.source_type,
          currentBoardToken: company.ats_board_token,
          candidate: {
            provider: candidate.provider,
            boardToken: candidate.boardToken,
            canonicalUrl: candidate.canonicalUrl,
            confidence: candidate.confidence,
            validationStatus: candidate.validationStatus,
            recommendation: candidate.recommendation,
            evidenceTypes: candidate.evidenceTypes,
            evidenceUrls: candidate.evidenceUrls,
          },
        });
        if (proposal) {
          console.log(`    PERSISTED: proposal #${proposal.id} (${proposal.status}, approvable=${isProposalApprovable(proposal)})`);
        } else {
          console.log(`    NOT PERSISTED: an existing REJECTED or APPROVED proposal already covers this exact candidate identity`);
        }
      }
    }
    console.log("");
  }

  console.log(
    persistProposals
      ? "Shadow run complete. Only ats_source_proposals rows were written — no company, job_source, job, or lifecycle data was modified. Nothing was approved."
      : "Shadow run complete. No source, job_sources, job, or lifecycle data was modified."
  );
}

main().catch((error) => {
  console.error("Discovery V2 shadow run failed:", error);
  process.exit(1);
});
