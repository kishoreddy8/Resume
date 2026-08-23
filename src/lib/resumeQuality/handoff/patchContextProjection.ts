import type { RepairPlan } from "../repairScope";
import { isPatchEligibleRepairPlan } from "./patchRepair";
import type { CoverLetterContent, ExperienceEntry, ResumeContent } from "../../../../tools/tailoring-engine/types";

/**
 * PHASE 2 TOKEN OPTIMIZATION — path-level input context for patch-eligible TARGETED_REPAIR
 * (2026-08-23).
 *
 * Phase 1 (patchRepair.ts) let the writer return a handful of {path, replacement} operations
 * instead of a full document. It did NOT shrink the writer's INPUT: `previous_resume_content.json`
 * / `previous_cover_letter_content.json` were still sent in full every time, because the writer's
 * own patch-mode instructions already say "do not reproduce content you are not changing" — the
 * writer never needed to COPY the untouched content, but it was still being SHOWN all of it.
 *
 * This module builds a writer-facing PROJECTION of the previous resume/cover-letter for
 * patch-eligible repairs only: touched employers keep a bounded neighborhood of bullets around
 * what's actually editable; untouched employers are reduced to an identity stub (employer/title/
 * dates only — enough to keep the candidate's timeline coherent, nothing an untouched employer's
 * bullets add that the writer needs, since patch reconstruction fills them back in from the REAL,
 * full baseline automatically regardless of what the writer saw). The cover letter is omitted from
 * writer-read context entirely when nothing about this repair concerns it.
 *
 * SAFETY. This is a writer-facing PROJECTION only — never a second source of truth. The projected
 * resume is written to the SAME `previous_resume_content.json` filename the writer's prompt already
 * references; repairPreservation.ts and the deterministic reviewer never see it — they validate
 * against the REAL, full, untouched baseline exactly as before this module existed (see
 * writerInput.currentResume in orchestrator.ts, never anything this module produces). The writer's
 * OUTPUT (a patch response) never needs to reproduce ANY previous-document content verbatim, so
 * reducing what it's SHOWN cannot cause it to echo back a reduced/stub value as if it were real —
 * that failure mode is specific to the legacy full-document contract, which this module never
 * touches (isPatchEligibleRepairPlan already gates which repairs use patch mode at all).
 *
 * FAIL TOWARD FULL CONTEXT. Every ambiguity here resolves to `usedFullContext: true` — the original,
 * complete resume, untouched. This is deliberately narrower than "every patch-eligible repair gets
 * a reduced context": a repair touching `resume.summary[N]`/`resume.tagline` still uses the FULL
 * resume (see PROJECTABLE_PATH_PATTERNS below) — positioning language plausibly depends on evidence
 * anywhere in the candidate's history, and this pass did not build the broader, JD-aware
 * SUMMARY_CONTEXT a safe reduction there would require.
 */

export interface RepairContextManifest {
  mode: "PATCH_TARGETED_REPAIR" | "FULL_CONTEXT";
  editablePaths: readonly string[];
  touchedEmployers: string[];
  reducedEmployers: string[];
  coverLetterOmitted: boolean;
  fallbackReason: string | null;
}

export interface ProjectedResumeContextResult {
  resume: ResumeContent;
  manifest: RepairContextManifest;
  usedFullContext: boolean;
}

const STUB_BULLET =
  "(other bullets omitted — this employer is not part of this repair; do not reference, modify, or reproduce content for it. It is preserved automatically.)";

/** Path shapes this module knows how to build a reduced context for. Deliberately narrower than
 *  patchRepair.ts's own STRING_LEAF_PATH_PATTERNS: summary/tagline/certifications/education are
 *  patch-OUTPUT-eligible but NOT input-projection-eligible here — see this module's own doc comment
 *  for why summary/tagline specifically fall back to full context. Certifications/education are
 *  small, resume-wide facts already kept in full regardless of projection (see below), so a repair
 *  touching ONLY one of those still benefits from employer-bullet reduction and is accepted here. */
const BULLET_PATH = /^resume\.experience\[(\d+)\]\.bullets\[(\d+)\]$/;
const PROJECT_DESCRIPTION_PATH = /^resume\.experience\[(\d+)\]\.projectDescription$/;
const SKILL_GROUPS_PATH = "resume.skillGroups";
const CERTIFICATION_PATH = /^resume\.certifications\[\d+\]$/;
const EDUCATION_PATH = /^resume\.education\[\d+\]$/;
const GLOBAL_IDENTITY_PATH = /^resume\.(summary\[\d+\]|tagline)$/;

const BULLET_NEIGHBOR_WINDOW = 2;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Whether ANY editable path is a shape this module doesn't reduce input context for — summary/
 *  tagline (see module doc comment) or anything patchRepair.ts itself wouldn't authorize (which
 *  should never reach here in practice, since callers only invoke this after confirming
 *  isPatchEligibleRepairPlan, but checked directly so this function is safe standalone). */
function requiresFullContext(editablePaths: readonly string[]): string | null {
  if (editablePaths.some((p) => GLOBAL_IDENTITY_PATH.test(p))) {
    return "repair touches resume.summary/resume.tagline — positioning language needs full context, not a reduced projection";
  }
  return null;
}

function stubExperienceEntry(entry: ExperienceEntry): ExperienceEntry {
  return {
    title: entry.title,
    company: entry.company,
    ...(entry.location ? { location: entry.location } : {}),
    dates: entry.dates,
    bullets: [STUB_BULLET],
  };
}

/**
 * Builds a writer-facing projection of the baseline resume for a patch-eligible repair. Returns
 * `usedFullContext: true` (and the ORIGINAL resume, byte-for-byte) whenever reduction cannot be
 * proven safe — never a partially-reduced fallback.
 */
export function projectResumeContextForPatchRepair(
  baselineResume: ResumeContent,
  repairPlan: RepairPlan | undefined
): ProjectedResumeContextResult {
  const editablePaths = repairPlan?.editablePaths;
  const fullContext = (reason: string): ProjectedResumeContextResult => ({
    resume: clone(baselineResume),
    manifest: {
      mode: "FULL_CONTEXT",
      editablePaths: editablePaths ?? [],
      touchedEmployers: [],
      reducedEmployers: [],
      coverLetterOmitted: false,
      fallbackReason: reason,
    },
    usedFullContext: true,
  });

  if (!editablePaths || editablePaths.length === 0) return fullContext("no editable paths");
  if (!isPatchEligibleRepairPlan(editablePaths)) return fullContext("repair plan is not patch-eligible");
  const globalReason = requiresFullContext(editablePaths);
  if (globalReason) return fullContext(globalReason);

  // Bullet windows per employer index, union'd across every touched bullet at that employer.
  const bulletWindows = new Map<number, Set<number>>();
  // Employers touched via projectDescription keep ALL their bullets (a project-description
  // repair summarizes the whole role — a bounded window risks an inaccurate summary).
  const fullBulletEmployers = new Set<number>();
  let touchesExperience = false;

  for (const p of editablePaths) {
    const bulletMatch = BULLET_PATH.exec(p);
    if (bulletMatch) {
      touchesExperience = true;
      const empIdx = Number(bulletMatch[1]);
      const bulletIdx = Number(bulletMatch[2]);
      const window = bulletWindows.get(empIdx) ?? new Set<number>();
      for (let i = bulletIdx - BULLET_NEIGHBOR_WINDOW; i <= bulletIdx + BULLET_NEIGHBOR_WINDOW; i++) {
        if (i >= 0) window.add(i);
      }
      bulletWindows.set(empIdx, window);
      continue;
    }
    const projectMatch = PROJECT_DESCRIPTION_PATH.exec(p);
    if (projectMatch) {
      touchesExperience = true;
      fullBulletEmployers.add(Number(projectMatch[1]));
      continue;
    }
    // skillGroups / certifications / education: resume-wide facts kept in full regardless (see
    // below); they don't by themselves require touching the experience-reduction logic at all.
    if (p === SKILL_GROUPS_PATH || CERTIFICATION_PATH.test(p) || EDUCATION_PATH.test(p)) continue;
    // Any other patch-safe-but-unrecognized-by-this-module shape — fail toward full context rather
    // than guess at a reduction rule for a path this projection was never designed for.
    return fullContext(`path shape not covered by input-context projection: ${p}`);
  }

  const touchedEmployers: string[] = [];
  const reducedEmployers: string[] = [];

  const experience = baselineResume.experience.map((entry, idx) => {
    // This repair never touches experience at all (e.g. a skillGroups-only or
    // certifications-only repair) — nothing here needs scoping, keep every employer as-is.
    if (!touchesExperience) return entry;

    if (fullBulletEmployers.has(idx)) {
      // projectDescription touched — keep every bullet for this employer (see this module's own
      // doc comment on why a bounded window is unsafe for a role-summarizing repair).
      touchedEmployers.push(entry.company);
      return entry;
    }
    if (bulletWindows.has(idx)) {
      touchedEmployers.push(entry.company);
      const window = bulletWindows.get(idx)!;
      return { ...entry, bullets: entry.bullets.filter((_, i) => window.has(i)) };
    }
    reducedEmployers.push(entry.company);
    return stubExperienceEntry(entry);
  });

  return {
    resume: { ...clone(baselineResume), experience },
    manifest: {
      mode: "PATCH_TARGETED_REPAIR",
      editablePaths,
      touchedEmployers: [...new Set(touchedEmployers)],
      reducedEmployers: [...new Set(reducedEmployers)],
      coverLetterOmitted: false, // set by the caller — this function only projects the resume
      fallbackReason: null,
    },
    usedFullContext: false,
  };
}

/**
 * Whether `previous_cover_letter_content.json` can be omitted from writer-read context. Patch mode
 * never touches the cover letter (isPatchEligibleRepairPlan refuses any repair with a coverLetter
 * editable path), so the only remaining reason the writer would need it is an OUTSTANDING finding
 * that concerns the cover letter without (yet) having an authorized editable path — a cross-
 * document-consistency root finding, or any unattributed/ambiguous finding at all (fail toward
 * inclusion when a finding's relevance to the cover letter can't be ruled out).
 */
export function shouldOmitCoverLetterContext(repairPlan: RepairPlan | undefined): boolean {
  if (!repairPlan) return false;
  if ((repairPlan.coverLetterFindings?.length ?? 0) > 0) return false;
  if ((repairPlan.unattributedFindings?.length ?? 0) > 0) return false;
  return true;
}

export function cloneCoverLetter(coverLetter: CoverLetterContent): CoverLetterContent {
  return clone(coverLetter);
}

/** A short, writer-facing (and human-debugging-facing) record of what previous_resume_content.json
 *  actually contains for this handoff — deliberately compact per this ticket's own instruction not
 *  to add significant token overhead. Empty string when context was never reduced (nothing useful
 *  to say). */
export function renderContextManifestSection(manifest: RepairContextManifest, coverLetterOmitted: boolean): string {
  if (manifest.mode === "FULL_CONTEXT") return "";
  let out = "## CONTEXT MANIFEST — what previous_resume_content.json contains for this repair\n\n";
  out += `- Full context shown for: ${manifest.touchedEmployers.join(", ") || "(none — this repair does not touch experience)"}\n`;
  if (manifest.reducedEmployers.length > 0) {
    out += `- Shown by name/title/dates only (bullets omitted, frozen, unrelated to this repair): ${manifest.reducedEmployers.join(", ")}\n`;
  }
  out += `- Cover letter: ${coverLetterOmitted ? "omitted (not relevant to this repair)" : "included"}\n\n`;
  return out;
}
