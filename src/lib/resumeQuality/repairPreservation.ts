import type { CoverLetterContent, ResumeContent } from "./types";
import { splitSentences, type RepairPlan } from "./repairScope";

export interface RepairPreservationInput {
  baselineResume: ResumeContent;
  baselineCoverLetter?: CoverLetterContent;
  repairedResume: ResumeContent;
  repairedCoverLetter?: CoverLetterContent;
  repairPlan: RepairPlan;
}

export interface RepairPreservationResult {
  valid: boolean;
  violations: string[];
}

type PackageContent = { resume: ResumeContent; coverLetter?: CoverLetterContent };

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function pathTokens(path: string): Array<string | number> {
  const tokens: Array<string | number> = [];
  for (const match of path.matchAll(/([A-Za-z][A-Za-z0-9_]*)|\[(\d+)\]/g)) {
    tokens.push(match[2] === undefined ? match[1]! : Number(match[2]));
  }
  return tokens;
}

function valueAt(root: unknown, tokens: Array<string | number>): unknown {
  let current = root;
  for (const token of tokens) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[token];
  }
  return current;
}

function setValueAt(root: unknown, tokens: Array<string | number>, value: unknown): boolean {
  if (tokens.length === 0) return false;
  let current = root;
  for (const token of tokens.slice(0, -1)) {
    if (current === null || current === undefined || typeof current !== "object") return false;
    current = (current as Record<string | number, unknown>)[token];
  }
  if (current === null || current === undefined || typeof current !== "object") return false;
  (current as Record<string | number, unknown>)[tokens[tokens.length - 1]!] = clone(value);
  return true;
}

function collectDiffs(expected: unknown, actual: unknown, path: string, diffs: string[]): void {
  if (diffs.length >= 25) return;
  if (Object.is(expected, actual)) return;
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      diffs.push(path);
      return;
    }
    if (expected.length !== actual.length) diffs.push(`${path}.length`);
    const length = Math.min(expected.length, actual.length);
    for (let i = 0; i < length; i++) collectDiffs(expected[i], actual[i], `${path}[${i}]`, diffs);
    return;
  }
  if (expected && actual && typeof expected === "object" && typeof actual === "object") {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of keys) {
      collectDiffs(
        (expected as Record<string, unknown>)[key],
        (actual as Record<string, unknown>)[key],
        path ? `${path}.${key}` : key,
        diffs
      );
    }
    return;
  }
  diffs.push(path);
}

/**
 * Validates a targeted repair by starting from an exact clone of the baseline and copying ONLY the
 * contract's editable paths from the writer output. The reconstructed package must then equal the
 * writer output. This is an allowlist: unmentioned paths are frozen automatically, including fields
 * added by a future schema extension.
 */
export function validateRepairPreservation(input: RepairPreservationInput): RepairPreservationResult {
  const editablePaths = input.repairPlan.editablePaths;
  if (!editablePaths) {
    return { valid: false, violations: ["repairPlan.editablePaths is missing"] };
  }

  const baseline: PackageContent = {
    resume: clone(input.baselineResume),
    ...(input.baselineCoverLetter ? { coverLetter: clone(input.baselineCoverLetter) } : {}),
  };
  const repaired: PackageContent = {
    resume: input.repairedResume,
    ...(input.repairedCoverLetter ? { coverLetter: input.repairedCoverLetter } : {}),
  };
  const expected = clone(baseline);
  const violations: string[] = [];

  const sentencePaths = new Map<number, Set<number>>();
  const ordinaryPaths: string[] = [];
  for (const path of editablePaths) {
    const sentence = /^coverLetter\.paragraphs\[(\d+)\]\.sentences\[(\d+)\]$/.exec(path);
    if (!sentence) {
      ordinaryPaths.push(path);
      continue;
    }
    const paragraphIndex = Number(sentence[1]);
    const sentenceIndex = Number(sentence[2]);
    const allowed = sentencePaths.get(paragraphIndex) ?? new Set<number>();
    allowed.add(sentenceIndex);
    sentencePaths.set(paragraphIndex, allowed);
  }

  for (const [paragraphIndex, allowedSentences] of sentencePaths) {
    const paragraphViolationCount = violations.length;
    const baselineParagraph = baseline.coverLetter?.paragraphs[paragraphIndex];
    const repairedParagraph = repaired.coverLetter?.paragraphs[paragraphIndex];
    if (baselineParagraph === undefined || repairedParagraph === undefined) {
      violations.push(`coverLetter.paragraphs[${paragraphIndex}] is missing`);
      continue;
    }
    const before = splitSentences(baselineParagraph);
    const after = splitSentences(repairedParagraph);
    if (before.length !== after.length) {
      violations.push(`coverLetter.paragraphs[${paragraphIndex}].sentenceCount`);
      continue;
    }
    for (let sentenceIndex = 0; sentenceIndex < before.length; sentenceIndex++) {
      if (!allowedSentences.has(sentenceIndex) && before[sentenceIndex] !== after[sentenceIndex]) {
        violations.push(`coverLetter.paragraphs[${paragraphIndex}].sentences[${sentenceIndex}]`);
      }
    }
    if (violations.length === paragraphViolationCount && expected.coverLetter) {
      expected.coverLetter.paragraphs[paragraphIndex] = repairedParagraph;
    }
  }

  for (const path of ordinaryPaths) {
    const tokens = pathTokens(path);
    const repairedValue = valueAt(repaired, tokens);
    if (repairedValue === undefined || !setValueAt(expected, tokens, repairedValue)) {
      violations.push(`${path} is not present in both baseline and repair output`);
    }
  }

  collectDiffs(expected, repaired, "", violations);
  return { valid: violations.length === 0, violations: [...new Set(violations)].slice(0, 25) };
}
