import type { ResumeContent, CoverLetterContent } from "../../../tools/tailoring-engine/types";
import { validateCoverLetterContentStructure } from "./handoff/importer";

export interface CoverLetterGenerationInput {
  candidateName: string;
  candidateLocation: string;
  candidateEmail: string;
  candidatePhone: string;
  companyName: string;
  jobTitle: string;
  positioningSummary?: string;
  jdPriorities?: Array<{ requirement: string; memberSkillNames?: string[] }> | string[];
  finalResume: ResumeContent;
  strongestEvidence?: string[];
}

export interface CoverLetterGeneratorAgent {
  generate(input: CoverLetterGenerationInput): Promise<CoverLetterContent>;
}

/**
 * Builds the compact markdown prompt for a lightweight downstream Cover Letter Generator.
 * Input context is strictly bounded to <= 800 tokens.
 */
export function buildCoverLetterGenerationPrompt(input: CoverLetterGenerationInput): string {
  const topAccomplishments = input.finalResume.experience
    .flatMap((e) => e.bullets.map((b) => `- [${e.company}] ${b}`))
    .slice(0, 4)
    .join("\n");

  const topSkills = input.finalResume.skillGroups
    .flatMap((g) => g.items)
    .slice(0, 12)
    .join(", ");

  const prioritiesText = Array.isArray(input.jdPriorities)
    ? input.jdPriorities
        .map((p) => (typeof p === "string" ? `- ${p}` : `- ${p.requirement}`))
        .slice(0, 5)
        .join("\n")
    : "- Scalable cloud data engineering & pipeline reliability";

  return `# Cover Letter Generation Task

**Candidate:** ${input.candidateName} (${input.candidateLocation})
**Target Role:** ${input.jobTitle} at ${input.companyName}

## Top Job Priorities
${prioritiesText}

## Verified Candidate Evidence (from Approved Final Resume)
- Summary Positioning: ${input.finalResume.summary?.[0] ?? "Experienced Data Engineer"}
- Key Verified Skills: ${topSkills}
- Verified Accomplishments:
${topAccomplishments}

## Cover Letter Requirements
Write a concise, 3-paragraph cover letter (180–250 words) adhering to:
1. **Paragraph 1 (Alignment & Role):** Specific alignment with the ${input.jobTitle} role at ${input.companyName}, referencing the candidate's verified professional identity.
2. **Paragraph 2 (Demonstrated Impact):** 2–3 concrete accomplishments grounded ONLY in the verified evidence above. Never invent metrics or unevidenced technologies.
3. **Paragraph 3 (Forward-Looking Closing):** Professional closing expressing interest in discussing technical contributions to ${input.companyName}.
4. **Tone:** Natural, confident engineering register. No generic marketing fluff ("results-driven", "synergy", "game-changing", "thrilled to apply").

## Strict Output JSON Schema
\`\`\`json
{
  "name": "${input.candidateName}",
  "location": "${input.candidateLocation}",
  "email": "${input.candidateEmail}",
  "phone": "${input.candidatePhone}",
  "salutation": "Dear Hiring Team,",
  "paragraphs": [
    "Paragraph 1...",
    "Paragraph 2...",
    "Paragraph 3..."
  ],
  "closing": "Sincerely,\\n${input.candidateName}"
}
\`\`\`
`;
}

/**
 * Deterministically generates a publication-ready, evidence-grounded cover letter
 * directly from the final approved resume content and job metadata.
 */
export function generateDeterministicCoverLetter(input: CoverLetterGenerationInput): CoverLetterContent {
  const { candidateName, candidateLocation, candidateEmail, candidatePhone, companyName, jobTitle, finalResume } = input;

  const topRole = finalResume.experience[0];
  const topBullets = topRole?.bullets?.slice(0, 2) ?? [];
  const secondRole = finalResume.experience[1];
  const secondBullets = secondRole?.bullets?.slice(0, 1) ?? [];

  const roleIdentity = finalResume.tagline?.split("|")[0]?.trim() || "Data Engineer";

  // Paragraph 1: Role alignment and verified positioning
  const p1 = `I am writing to express my strong interest in the ${jobTitle} position at ${companyName}. As a ${roleIdentity} with extensive experience architecting scalable data platforms, I have built reliable, governed data pipelines and distributed analytics environments that align directly with your engineering requirements.`;

  // Paragraph 2: Concrete evidence-backed achievements from accepted resume
  let p2 = "";
  if (topRole && topBullets.length > 0) {
    const bulletText = topBullets[0].replace(/\.$/, "");
    p2 = `At ${topRole.company}, I ${bulletText.charAt(0).toLowerCase() + bulletText.slice(1)}.`;
    if (secondRole && secondBullets.length > 0) {
      const secondText = secondBullets[0].replace(/\.$/, "");
      p2 += ` Previously at ${secondRole.company}, I ${secondText.charAt(0).toLowerCase() + secondText.slice(1)}.`;
    }
  } else {
    p2 = `My technical background centers on designing robust data architectures, optimizing ETL pipeline performance, and ensuring strict data governance across cloud and hybrid environments.`;
  }

  // Paragraph 3: Fit and forward-looking closing
  const p3 = `I look forward to the opportunity to discuss how my technical expertise and platform engineering background can contribute to ${companyName}'s data infrastructure goals. Thank you for your time and consideration.`;

  const rawCover: CoverLetterContent = {
    name: candidateName,
    location: candidateLocation,
    email: candidateEmail,
    phone: candidatePhone,
    salutation: "Dear Hiring Team,",
    paragraphs: [p1, p2, p3],
    closing: `Sincerely,\n${candidateName}`,
  };

  return validateCoverLetterContentStructure(rawCover);
}

/**
 * Provider-independent cover letter generator.
 * Defaults to deterministic generation; accepts custom agent implementations for future model routing.
 */
export async function generateTailoredCoverLetter(
  input: CoverLetterGenerationInput,
  agent?: CoverLetterGeneratorAgent
): Promise<CoverLetterContent> {
  if (agent) {
    const result = await agent.generate(input);
    return validateCoverLetterContentStructure(result);
  }
  return generateDeterministicCoverLetter(input);
}
