import type { ResumeContent, CoverLetterContent } from "../../../../tools/tailoring-engine/types";
import type { ResumeWriterAgent, ResumeWriterInput, ResumeWriterOutput } from "../types";
import { resolveSkillForReview } from "../reviewers/skillAliases";

export interface LocalImprovementWriterOptions {
  /** Optional custom transform function for testing specific responses */
  transform?: (input: ResumeWriterInput) => Promise<ResumeWriterOutput> | ResumeWriterOutput;
  /** Optional fixed resume to return */
  outputResume?: ResumeContent;
  /** Optional fixed cover letter to return */
  outputCoverLetter?: CoverLetterContent;
  /** Throw an error when generating for a specific iteration number (tests failure safety) */
  failOnIteration?: number;
  /** Custom error message when failing */
  failureMessage?: string;
}

/**
 * Deterministic, network-free ResumeWriterAgent test double (Stage 10).
 *
 * Programmatically addresses feedback from StructuredResumeReview to produce improved
 * structured resumes across multi-turn quality loops without external AI providers.
 */
export class LocalImprovementWriter implements ResumeWriterAgent {
  constructor(private readonly options: LocalImprovementWriterOptions = {}) {}

  async generate(input: ResumeWriterInput): Promise<ResumeWriterOutput> {
    if (this.options.failOnIteration && input.iterationNumber === this.options.failOnIteration) {
      throw new Error(
        this.options.failureMessage ??
          `Simulated writer failure on iteration ${input.iterationNumber}`
      );
    }

    if (this.options.transform) {
      return this.options.transform(input);
    }

    if (this.options.outputResume) {
      return {
        resume: this.options.outputResume,
        coverLetter: this.options.outputCoverLetter ?? input.currentCoverLetter,
      };
    }

    if (!input.currentResume) {
      throw new Error("LocalImprovementWriter requires input.currentResume or an explicit outputResume");
    }

    // Clone current resume
    const improvedResume: ResumeContent = JSON.parse(JSON.stringify(input.currentResume));

    // 1. Fix competing technologies (architecture contradictions)
    if (input.latestReview?.incorrectTechnologyUsage && input.latestReview.incorrectTechnologyUsage.length > 0) {
      for (const role of improvedResume.experience) {
        role.bullets = role.bullets.map((b) => {
          // If bullet has "AWS Glue" alongside "Azure Data Factory", frame as migration
          if (/Azure Data Factory/i.test(b) && /AWS Glue/i.test(b) && !/migrat/i.test(b)) {
            return b.replace(/and AWS Glue/i, "migrated from legacy AWS Glue pipelines");
          }
          // Generic competing tools
          return b.replace(/Azure Data Factory\s+and\s+AWS Glue/gi, "Azure Data Factory");
        });
      }
    }

    // 2. Fix truthfulness / title mismatches
    if (input.latestReview?.truthfulnessIssues && input.latestReview.truthfulnessIssues.length > 0) {
      if (input.masterProfile?.experience && input.masterProfile.experience.length > 0) {
        for (const role of improvedResume.experience) {
          const matched = input.masterProfile.experience.find(
            (m) => m.employer.toLowerCase().includes(role.company.toLowerCase()) ||
                   role.company.toLowerCase().includes(m.employer.toLowerCase())
          );
          if (matched) {
            role.title = matched.title;
          }
        }
      }
    }

    // 3. Fix generic bullets
    if (input.latestReview?.genericBullets && input.latestReview.genericBullets.length > 0) {
      for (const role of improvedResume.experience) {
        role.bullets = role.bullets.map((b) => {
          let updated = b.replace(/^Responsible for\s+/i, "Architected and engineered ");
          updated = updated.replace(/^Worked on\s+/i, "Designed and deployed ");
          return updated;
        });
      }
    }

    // 4. Fix missing required skills
    if (input.latestReview?.missingRequiredSkills && input.latestReview.missingRequiredSkills.length > 0) {
      if (improvedResume.skillGroups.length > 0) {
        const firstCategory = improvedResume.skillGroups[0];
        const evidenced = new Set(
          [
            ...(input.masterProfile?.skills.map((skill) => skill.rawSkillName) ?? []),
            ...(input.masterProfile?.experience.flatMap((entry) => entry.technologies) ?? []),
          ].map((skill) => resolveSkillForReview(skill)?.canonical ?? skill)
        );
        for (const skill of input.latestReview.missingRequiredSkills) {
          const canonical = resolveSkillForReview(skill)?.canonical ?? skill;
          if (evidenced.has(canonical) && !firstCategory.items.some((item) => (resolveSkillForReview(item)?.canonical ?? item) === canonical)) {
            firstCategory.items.push(skill);
          }
        }
      }
    }

    // 5. Fix blocking issues (e.g. unevidenced certifications or employers)
    if (input.latestReview?.blockingIssues && input.latestReview.blockingIssues.length > 0) {
      // If certification mismatch, align certifications with master profile
      if (input.masterProfile?.certifications) {
        improvedResume.certifications = input.masterProfile.certifications.map((c) => c.name);
      }
    }

    return {
      resume: improvedResume,
      coverLetter: input.currentCoverLetter,
    };
  }
}
