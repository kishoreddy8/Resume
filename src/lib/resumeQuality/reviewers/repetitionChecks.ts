import type { ResumeContent } from "../../../../tools/tailoring-engine/types";
import { classifyAccomplishment, type AccomplishmentCategory } from "../accomplishmentEvidence";
import { classifyTechnologiesIntoStages } from "../compactEvidence";

/**
 * PHASE 6.8 — cross-employer (and same-employer) SEMANTIC bullet repetition.
 *
 * bulletChecks.ts's existing duplicate-bullet check (normalizeForDuplicateCheck) only catches
 * near-LITERAL text duplication — it is blind to "Built ADF pipelines from SQL Server into ADLS…"
 * at one employer and "Developed ADF pipelines moving SQL Server data into ADLS…" at another: same
 * responsibility, same architecture, same purpose, only the verb (and a little wording) differs.
 * This module is a separate, additive REPORTING/QUALITY check for exactly that gap — it does NOT
 * replace bulletChecks.ts's literal check, and it is NOT a bullet planner/generator: it only reads
 * already-written bullets and reports pairs that look like the same underlying responsibility
 * restated, so a human/writer can judge whether that is truthful overlap or accidental repetition.
 *
 * SIGNAL DESIGN (deliberately conservative — every signal below is reused from an existing,
 * already-tested classifier; nothing here is new NLP):
 *   - responsibility category: accomplishmentEvidence.ts's classifyAccomplishment().category, the
 *     SAME keyword classifier already used to build AccomplishmentUnits from master-resume text —
 *     reused here on GENERATED bullet text, which is exactly the same shape of input (one sentence
 *     of engineering prose). "general" bullets are excluded: too vague a bucket to compare safely.
 *   - architecture stage shape: compactEvidence.ts's classifyTechnologiesIntoStages() bucketing a
 *     bullet's named technologies into source/orchestration/processing/storage/warehouse — the same
 *     stage taxonomy the compact-evidence arrow notation already uses.
 *   - exact technology overlap: the same canonical technology named in both bullets.
 *
 * A pair is only reported when ALL THREE line up: same category AND >= 2 shared stage buckets AND
 * >= 2 shared exact technologies. This is what makes "Snowflake at all 3 employers" alone, or
 * "Azure Data Factory at 2 employers" alone, NOT a finding — a single shared technology or a single
 * shared stage is common, truthful overlap for a candidate who has genuinely used the same platform
 * more than once, and neither threshold is met by one shared thing. Verb substitution provides no
 * protection: none of these three signals reads the bullet's opening verb.
 */

export type RepetitionScope = "SAME_EMPLOYER" | "CROSS_EMPLOYER";

export interface RepetitionFinding {
  scope: RepetitionScope;
  employerA: string;
  bulletIndexA: number;
  textA: string;
  employerB: string;
  bulletIndexB: number;
  textB: string;
  sharedCategory: AccomplishmentCategory;
  sharedTechnologies: string[];
  sharedStages: string[];
  reason: string;
}

export interface RepetitionCheckResult {
  status: "PASS" | "REVIEW";
  findings: RepetitionFinding[];
}

const STAGE_KEYS = ["source", "orchestration", "processing", "storage", "warehouse"] as const;
type StageKey = (typeof STAGE_KEYS)[number];

/** A pair must clear BOTH thresholds — either alone is exactly the "repeated technology/stage alone
 *  is not repetition" case this check must not flag. */
const MIN_SHARED_TECHNOLOGIES = 2;
const MIN_SHARED_STAGES = 2;

interface BulletProfile {
  employer: string;
  bulletIndex: number;
  text: string;
  category: AccomplishmentCategory;
  technologies: Set<string>;
  stages: Set<StageKey>;
}

function buildBulletProfile(employer: string, title: string, dates: string, bulletIndex: number, text: string): BulletProfile {
  const unit = classifyAccomplishment(text, employer, title, dates, bulletIndex);
  const stageBuckets = classifyTechnologiesIntoStages(unit.technologies);
  const stages = new Set<StageKey>();
  for (const stage of STAGE_KEYS) {
    if (stageBuckets[stage].length > 0) stages.add(stage);
  }
  return {
    employer,
    bulletIndex,
    text,
    category: unit.category,
    technologies: new Set(unit.technologies.map((t) => t.toLowerCase())),
    stages,
  };
}

/**
 * Reads ONLY already-generated resume bullets — never prescribes, ranks, or rewrites content. Pure
 * reporting: returns PASS when no pair clears both thresholds, REVIEW (never a hard block) with one
 * finding per offending pair otherwise, each with its own reason so a human can judge truthfulness
 * vs accidental repetition.
 */
export function evaluateCrossEmployerRepetition(resume: ResumeContent): RepetitionCheckResult {
  const profiles: BulletProfile[] = [];
  for (const role of resume.experience) {
    role.bullets.forEach((text, index) => {
      if (!text || !text.trim()) return;
      profiles.push(buildBulletProfile(role.company, role.title, role.dates, index, text));
    });
  }

  const findings: RepetitionFinding[] = [];
  for (let i = 0; i < profiles.length; i++) {
    for (let j = i + 1; j < profiles.length; j++) {
      const a = profiles[i];
      const b = profiles[j];
      if (a.category === "general" || a.category !== b.category) continue;

      const sharedTechnologies = [...a.technologies].filter((t) => b.technologies.has(t));
      if (sharedTechnologies.length < MIN_SHARED_TECHNOLOGIES) continue;

      const sharedStages = STAGE_KEYS.filter((s) => a.stages.has(s) && b.stages.has(s));
      if (sharedStages.length < MIN_SHARED_STAGES) continue;

      const scope: RepetitionScope = a.employer === b.employer ? "SAME_EMPLOYER" : "CROSS_EMPLOYER";
      const who = scope === "SAME_EMPLOYER" ? `Two bullets at ${a.employer}` : `${a.employer} and ${b.employer}`;
      findings.push({
        scope,
        employerA: a.employer,
        bulletIndexA: a.bulletIndex,
        textA: a.text,
        employerB: b.employer,
        bulletIndexB: b.bulletIndex,
        textB: b.text,
        sharedCategory: a.category,
        sharedTechnologies,
        sharedStages,
        reason:
          `${who} share the same responsibility category (${a.category}), ${sharedStages.length} architecture ` +
          `stage(s) (${sharedStages.join(", ")}), and ${sharedTechnologies.length} technologies ` +
          `(${sharedTechnologies.join(", ")}) — this reads as the same underlying responsibility restated rather ` +
          `than a distinct contribution, even though the wording differs.`,
      });
    }
  }

  return { status: findings.length === 0 ? "PASS" : "REVIEW", findings };
}
