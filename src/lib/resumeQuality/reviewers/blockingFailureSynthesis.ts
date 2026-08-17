import type { BlockingFailure, MetricProvenanceResult } from "../types";
import type { PlaceholderFinding } from "./placeholderChecks";

/**
 * Stage 21 (Evidence-Grounded Resume Quality V2) — the single place every already-computed check
 * result is mapped onto the named BlockingFailure taxonomy (types.ts's BLOCKING_FAILURE_TYPES). Pure
 * synthesis only, mirroring instructionCompliance.ts's own "this module runs zero checks of its own"
 * design: every input here was already computed by an existing reviewer module.
 */

export interface BuildBlockingFailuresInput {
  ungroundedTechnologies: string[];
  metricProvenance: MetricProvenanceResult;
  placeholderFindings: PlaceholderFinding[];
  employerScopedContradictions: string[];
  generalContradictions: string[];
  /** truthfulnessChecks.ts's own blockingIssues array — classified here by the (deliberately stable,
   *  owned-by-this-codebase) message prefix each category always uses, rather than widening
   *  TruthfulnessCheckResult's shape just to carry a redundant type tag. */
  truthfulnessBlockingIssues: string[];
}

export function buildBlockingFailures(input: BuildBlockingFailuresInput): BlockingFailure[] {
  const failures: BlockingFailure[] = [];

  for (const tech of input.ungroundedTechnologies) {
    failures.push({
      type: "UNSUPPORTED_CLAIM",
      description: `"${tech}" is claimed on the resume but is not grounded in the Master Resume or Master Skills Inventory.`,
      evidenceSearched: ["Master Resume", "Master Skills Inventory"],
      recommendedCorrection: `Remove "${tech}" or replace it with a genuinely evidenced technology.`,
    });
  }

  for (const entry of input.metricProvenance.entries) {
    if (entry.category !== "UNSUPPORTED") continue;
    failures.push({
      type: "UNSUPPORTED_METRIC",
      description: `Unsupported metric in bullet: "${entry.bullet}" (${entry.reason}).`,
      evidenceSearched: ["Master Resume", "Master Skills Inventory", "prior iteration bullets"],
      recommendedCorrection: "Remove the unsupported figure and retain a supported qualitative outcome instead.",
    });
  }

  for (const finding of input.placeholderFindings) {
    failures.push({
      type: "PLACEHOLDER_CONTACT",
      description: `${finding.field} contains a placeholder value: "${finding.value}" (${finding.reason})`,
      recommendedCorrection: "Omit this field entirely if a real value is unavailable — never fabricate one.",
    });
  }

  for (const description of input.employerScopedContradictions) {
    failures.push({ type: "EMPLOYER_CONTRADICTION", description, evidenceSearched: ["resume experience bullets"] });
  }
  for (const description of input.generalContradictions) {
    failures.push({ type: "CROSS_ARTIFACT_CONTRADICTION", description, evidenceSearched: ["resume (all sections)"] });
  }

  for (const issue of input.truthfulnessBlockingIssues) {
    if (issue.startsWith("Dates")) {
      failures.push({ type: "DATE_CONTRADICTION", description: issue, evidenceSearched: ["Master Resume"] });
    } else if (issue.startsWith("Certification")) {
      failures.push({ type: "CERTIFICATION_CONTRADICTION", description: issue, evidenceSearched: ["Master Resume", "Master Skills Inventory"] });
    } else if (issue.startsWith("Employer")) {
      failures.push({ type: "EMPLOYER_CONTRADICTION", description: issue, evidenceSearched: ["Master Resume"] });
    } else {
      // Title mismatches and any future truthfulness blocking category not yet named above — still
      // reported, generically, rather than silently dropped from the typed taxonomy.
      failures.push({ type: "UNSUPPORTED_CLAIM", description: issue, evidenceSearched: ["Master Resume"] });
    }
  }

  return failures;
}
