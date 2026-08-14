import type { RequiredCorrection } from "../types";
import type { ResumeContent } from "../../../../tools/tailoring-engine/types";

export interface StructuralCheckResult {
  formattingScore: number;
  corrections: RequiredCorrection[];
  /** A completely missing/empty core section (summary, skills, or experience) is severe enough to
   *  become a blocking issue, not just a formatting deduction — a resume genuinely missing its
   *  Professional Experience section is not "low quality," it is not a usable resume. */
  blockingIssues: string[];
}

/** Pure structural checks against the ResumeContent model itself — no OCR/PDF/visual layout
 *  inspection, matching "use the structured resume content model" from the Stage 8 spec. */
export function evaluateStructuralChecks(resume: ResumeContent): StructuralCheckResult {
  const corrections: RequiredCorrection[] = [];
  const blockingIssues: string[] = [];
  let deductions = 0;

  if (resume.summary.length === 0 || resume.summary.every((s) => s.trim().length === 0)) {
    blockingIssues.push("Professional Summary section is empty.");
    deductions += 30;
  }
  if (resume.skillGroups.length === 0) {
    blockingIssues.push("Technical Skills section is empty.");
    deductions += 30;
  }
  if (resume.experience.length === 0) {
    blockingIssues.push("Professional Experience section is empty.");
    deductions += 40;
  }
  if (resume.education.length === 0) {
    corrections.push({ priority: "MEDIUM", description: "Education section is empty." });
    deductions += 10;
  }

  // Duplicate skill-group headings.
  const seenLabels = new Set<string>();
  for (const group of resume.skillGroups) {
    const normalized = group.label.trim().toLowerCase();
    if (seenLabels.has(normalized)) {
      corrections.push({ priority: "LOW", description: `Duplicate Technical Skills heading: "${group.label}".` });
      deductions += 5;
    }
    seenLabels.add(normalized);
  }

  // Malformed/empty experience entries.
  resume.experience.forEach((role, i) => {
    if (role.bullets.length === 0) {
      corrections.push({ priority: "HIGH", description: `${role.company || `Role #${i + 1}`}: no bullets under this role.` });
      deductions += 15;
    }
    if (!role.company?.trim() || !role.title?.trim()) {
      corrections.push({ priority: "HIGH", description: `Role #${i + 1} is missing a company or title.` });
      deductions += 15;
    }
    if (!role.dates?.trim()) {
      corrections.push({ priority: "MEDIUM", description: `${role.company || `Role #${i + 1}`}: missing dates.` });
      deductions += 10;
    }
  });

  const formattingScore = Math.min(100, Math.max(0, 100 - deductions));
  return { formattingScore, corrections, blockingIssues };
}
