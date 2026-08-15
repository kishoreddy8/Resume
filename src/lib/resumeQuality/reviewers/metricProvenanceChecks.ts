import type { ExperienceEntry } from "../../../../tools/tailoring-engine/types";
import type { MetricProvenanceEntry, MetricProvenanceResult } from "../types";

/**
 * METRIC INFERENCE POLICY — categorizes every numeric claim found in the resume's experience
 * bullets into SOURCE_SUPPORTED / INFERRED_CONSERVATIVE / UNSUPPORTED (types.ts's
 * MetricProvenanceCategory), per the canonical instructions' explicit banned-category list (revenue,
 * dollar savings, customer/user counts, team sizes, regulatory/compliance outcomes) vs. allowed
 * engineering-metric categories (processing/runtime/query/latency/throughput/reliability/
 * data-quality/resource-efficiency/cost-efficiency-percentage improvements).
 *
 * HONEST LIMITATION: this reviewer has no access to the actual Master Resume bullet text (only
 * CandidateProfile's structured employer/title/date/technology facts — never original bullet
 * wording or metrics), so "was this number in the original Master Resume" cannot be verified from
 * first principles. SOURCE_SUPPORTED is therefore only ever assigned when `priorResume` is supplied
 * (an improvement iteration) AND the exact bullet+number already existed unchanged in that prior
 * iteration — i.e., "this number was already here before the writer's latest pass, not freshly
 * introduced." A genuinely new number in an allowed category is INFERRED_CONSERVATIVE, never
 * fabricated as SOURCE_SUPPORTED. See the module-level comment on truthfulnessChecks.ts's own
 * checkMetricRealism for the same "review required, never definitively false" philosophy this
 * extends rather than replaces (checkMetricRealism's cross-employer-repetition signal is untouched
 * and still feeds truthfulnessScore independently).
 */

const NUMBER_RE = /\b\d{1,3}%|\$[\d,]+(?:\.\d+)?[kKmMbB]?|\b\d{2,}(?:,\d{3})+\b/g;

const UNSUPPORTED_CONTEXT_RE = /\b(revenue|\$|dollar|cost savings|customers?|users?|clients? (?:base|acquired)|team of \d+|headcount|regulatory|compliance|audit)\b/i;

function extractNumbers(text: string): string[] {
  return text.match(NUMBER_RE) ?? [];
}

function normalizeBullet(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

export function evaluateMetricProvenance(experience: ExperienceEntry[], priorExperience: ExperienceEntry[] | undefined): MetricProvenanceResult {
  const priorBullets = new Set((priorExperience ?? []).flatMap((e) => e.bullets.map(normalizeBullet)));
  const entries: MetricProvenanceEntry[] = [];

  for (const role of experience) {
    for (const bullet of role.bullets) {
      const numbers = extractNumbers(bullet);
      if (numbers.length === 0) continue;

      if (UNSUPPORTED_CONTEXT_RE.test(bullet)) {
        entries.push({
          category: "UNSUPPORTED",
          bullet: bullet.trim(),
          reason: "Numeric claim appears alongside revenue/dollar/customer/team-size/regulatory language — outside the allowed metric-inference categories.",
        });
        continue;
      }

      if (priorBullets.has(normalizeBullet(bullet))) {
        entries.push({
          category: "SOURCE_SUPPORTED",
          bullet: bullet.trim(),
          reason: "This exact bullet (including its number) was already present in the prior iteration, not newly introduced.",
        });
        continue;
      }

      entries.push({
        category: "INFERRED_CONSERVATIVE",
        bullet: bullet.trim(),
        reason: "Numeric claim in an allowed engineering-metric category; provenance cannot be independently confirmed against the Master Resume's original text, so it is treated as a conservative inference, not a verified fact.",
      });
    }
  }

  return { entries, unsupportedCount: entries.filter((e) => e.category === "UNSUPPORTED").length };
}
