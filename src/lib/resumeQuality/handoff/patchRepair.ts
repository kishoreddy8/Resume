import { clone, pathTokens, setValueAt } from "../repairPreservation";
import type { CoverLetterContent, RepairPatchOperation, ResumeContent } from "../types";

/**
 * PATCH-BASED TARGETED_REPAIR (2026-08-23)
 *
 * WHY THIS EXISTS. TARGETED_REPAIR's writer is structurally required to return a COMPLETE resume
 * (and cover letter, when touched) even when only one bullet changed — repairPreservation.ts's
 * comparator does a full structural diff of the writer's ENTIRE returned document against the
 * baseline, and importer.ts's structure validators require every experience entry fully populated.
 * That means previous_resume_content.json / previous_cover_letter_content.json (the untouched
 * content the writer must reproduce verbatim) have to be sent as writer input in full, every time,
 * regardless of how narrow the repair is — the single largest remaining TARGETED_REPAIR context cost
 * that employer/master-reference scoping cannot touch.
 *
 * WHAT THIS MODULE DOES. Lets a patch-capable TARGETED_REPAIR writer return ONLY the approved
 * replacements (`{document, path, replacement}`) instead of the full document. CareerOps
 * reconstructs the complete resume/cover letter itself, deterministically, by cloning the immutable
 * baseline and applying ONLY operations whose path is an EXACT match to a path already present in
 * this repair's own `editablePaths` allowlist. From that point on, the reconstructed document flows
 * through the EXACT SAME pipeline as a legacy full-document response — the same
 * validateRepairPreservation comparator, the same structure validators, the same deterministic
 * reviewer with FULL evidence. Claude never becomes the authority over document structure: it can
 * only ever supply the VALUE that lands at a path CareerOps already decided was editable.
 *
 * REUSE, NOT REINVENTION. pathTokens/setValueAt are imported from repairPreservation.ts — the exact
 * primitives that module already uses to build its own "expected" comparison document. Reconstruction
 * here is the same operation applied for a different purpose, not a second implementation of path
 * traversal.
 *
 * SCOPE: RESUME-ONLY, THIS PASS. A cover-letter edit's canonical editable-path granularity is
 * `coverLetter.paragraphs[N].sentences[M]` (see repairScope.ts's baselineTextUnits/splitSentences) —
 * reconstructing a full paragraph from a patched sentence requires re-joining split sentences back
 * together, which is a second deterministic operation this pass did not build or test. Any repair
 * plan touching a `coverLetter.` path is therefore never eligible for patch mode — it falls back to
 * the legacy full-document contract, exactly as before this module existed. This is a deliberate,
 * documented scope decision, not an oversight — see isPatchEligibleRepairPlan.
 */

export const PATCH_OUTPUT_MODE = "PATCH" as const;
export const PATCH_SCHEMA_VERSION = 2 as const;

/** Every path SHAPE this module knows how to authorize a replacement TYPE for. Each entry's regex
 *  matches a full ("resume."/"coverLetter."-prefixed) path; `expectsArrayOfSkillGroups` is the one
 *  non-string replacement shape this pass supports (resume.skillGroups is edited as a whole array by
 *  repairScope.ts's MOVE_SUPPORTED_SKILL/REMOVE_UNSUPPORTED_SKILL operations, never per-item). Any
 *  path that matches none of these is NOT patch-safe — authorizePatchOperations rejects it and the
 *  exporter never offers patch mode when a repair's editablePaths contains one. */
const STRING_LEAF_PATH_PATTERNS: RegExp[] = [
  /^resume\.tagline$/,
  /^resume\.summary\[\d+\]$/,
  /^resume\.certifications\[\d+\]$/,
  /^resume\.education\[\d+\]$/,
  /^resume\.experience\[\d+\]\.bullets\[\d+\]$/,
  /^resume\.experience\[\d+\]\.projectDescription$/,
];
const SKILL_GROUPS_PATH = "resume.skillGroups";

function isReplacementValueValid(fullPath: string, replacement: unknown): boolean {
  if (fullPath === SKILL_GROUPS_PATH) {
    return (
      Array.isArray(replacement) &&
      replacement.every(
        (g) =>
          g &&
          typeof g === "object" &&
          typeof (g as { label?: unknown }).label === "string" &&
          Array.isArray((g as { items?: unknown }).items) &&
          (g as { items: unknown[] }).items.every((i) => typeof i === "string")
      )
    );
  }
  return STRING_LEAF_PATH_PATTERNS.some((re) => re.test(fullPath)) && typeof replacement === "string";
}

/** Whether the FULL path (already "resume."/"coverLetter."-prefixed) is one this module can safely
 *  reconstruct a replacement for. Used both to decide whether to OFFER patch mode (exporter.ts, over
 *  every path in editablePaths) and to AUTHORIZE what a patch response actually claims to edit. */
function isPatchSafePath(fullPath: string): boolean {
  return fullPath === SKILL_GROUPS_PATH || STRING_LEAF_PATH_PATTERNS.some((re) => re.test(fullPath));
}

/**
 * Whether THIS repair plan is eligible for patch mode at all. Conservative and fail-closed: any
 * editable path this module cannot safely reconstruct (including every `coverLetter.*` path — see
 * this module's own doc comment) disqualifies the WHOLE repair, not just that one path, so the
 * exporter falls back to legacy full-document mode rather than offering a patch contract the writer
 * could only partially satisfy.
 */
export function isPatchEligibleRepairPlan(editablePaths: readonly string[] | undefined): boolean {
  if (!editablePaths || editablePaths.length === 0) return false;
  return editablePaths.every((p) => isPatchSafePath(p));
}

export interface PatchReconstructionResult {
  resume: ResumeContent;
  coverLetter?: CoverLetterContent;
  /** Empty when every operation was authorized and applied. Non-empty means reconstruction was
   *  refused outright — callers must treat a non-empty violations array as a hard failure, never
   *  attempt to use `resume`/`coverLetter` (they are still the untouched baseline clone in that
   *  case, never a partially-applied document). */
  violations: string[];
}

/**
 * Deterministically reconstructs the complete resume (and cover letter, if a baseline was supplied)
 * from the immutable baseline plus a patch response's operations. Every operation's `document`+`path`
 * must combine to an EXACT match in `editablePaths` — not a prefix, not a parent, not a child, no
 * wildcard. Two operations targeting the same path, a path outside the allowlist, a malformed
 * operation, or a replacement of the wrong type for its path all fail the WHOLE reconstruction
 * closed (no partial application) rather than silently skipping just that operation, so an authorized
 * subset of operations can never mask an unauthorized one riding alongside it in the same response.
 * An editable path with NO matching operation simply keeps its baseline value — omission means
 * "leave unchanged", never "delete".
 */
export function reconstructFromPatchOperations(
  baselineResume: ResumeContent,
  baselineCoverLetter: CoverLetterContent | undefined,
  operations: unknown,
  editablePaths: readonly string[]
): PatchReconstructionResult {
  const resume = clone(baselineResume);
  const coverLetter = baselineCoverLetter ? clone(baselineCoverLetter) : undefined;
  const violations: string[] = [];

  if (!Array.isArray(operations)) {
    return { resume, coverLetter, violations: ["operations must be an array"] };
  }
  if (operations.length === 0) {
    return { resume, coverLetter, violations: ["operations must not be empty — a patch with nothing to apply is not a valid repair response"] };
  }

  const editableSet = new Set(editablePaths);
  const seenPaths = new Set<string>();

  for (const raw of operations) {
    if (!raw || typeof raw !== "object") {
      violations.push("malformed operation: not an object");
      continue;
    }
    const op = raw as Partial<RepairPatchOperation>;
    if (op.document !== "resume" && op.document !== "coverLetter") {
      violations.push(`unsupported document: ${String(op.document)}`);
      continue;
    }
    if (typeof op.path !== "string" || op.path.trim().length === 0) {
      violations.push(`malformed operation: path must be a non-empty string (document: ${op.document})`);
      continue;
    }
    const fullPath = `${op.document}.${op.path}`;

    if (op.document === "coverLetter") {
      // Never reachable when isPatchEligibleRepairPlan already refused the plan, but checked again
      // here so this function is itself safe to call directly (e.g. from tests) without relying on
      // the caller having pre-filtered — fail closed independently at every layer.
      violations.push(`coverLetter paths are not patch-eligible this pass: ${fullPath}`);
      continue;
    }
    if (!editableSet.has(fullPath)) {
      violations.push(`path not in editablePaths allowlist: ${fullPath}`);
      continue;
    }
    if (seenPaths.has(fullPath)) {
      violations.push(`duplicate operation for path: ${fullPath}`);
      continue;
    }
    if (!isReplacementValueValid(fullPath, op.replacement)) {
      violations.push(`replacement has the wrong type for path: ${fullPath}`);
      continue;
    }
    seenPaths.add(fullPath);
  }

  if (violations.length > 0) {
    // Fail the WHOLE reconstruction — return the untouched baseline clone, never a partial apply.
    return { resume: clone(baselineResume), coverLetter: baselineCoverLetter ? clone(baselineCoverLetter) : undefined, violations };
  }

  for (const raw of operations as RepairPatchOperation[]) {
    const target = raw.document === "resume" ? resume : coverLetter;
    setValueAt(target, pathTokens(raw.path), raw.replacement);
  }

  return { resume, coverLetter, violations: [] };
}
