import type { ResumeContent } from "../../../tools/tailoring-engine/types";

/**
 * Deterministic, template-based cold follow-up email generator — Resume Quality Hardening's
 * "OUTPUT REQUIREMENTS" item 10 ("Cold Follow-up Email"). No AI provider is involved: the text is
 * assembled from the already-approved, already-reviewed ResumeContent (name, tagline, top skills,
 * strongest bullet) plus the target role/company, exactly the same source-of-truth data the
 * resume itself was built from — so it can never contradict the resume it accompanies.
 *
 * Stored as its own artifact (cold_follow_up_email.md) and never inserted into the resume or
 * cover letter documents, and never used to drive any outbound recruiter-automation/sending
 * feature — CareerOps only ever produces the text for a human to review and send themselves.
 */
export interface ColdFollowUpEmailInput {
  resume: ResumeContent;
  companyName: string;
  jobTitle?: string;
}

function topSkills(resume: ResumeContent, max = 5): string[] {
  const skills: string[] = [];
  for (const group of resume.skillGroups) {
    for (const item of group.items) {
      if (!skills.includes(item)) skills.push(item);
      if (skills.length >= max) return skills;
    }
  }
  return skills;
}

function strongestBullet(resume: ResumeContent): string | undefined {
  return resume.experience[0]?.bullets?.[0];
}

export function generateColdFollowUpEmail(input: ColdFollowUpEmailInput): string {
  const { resume, companyName, jobTitle } = input;
  const role = jobTitle?.trim() || resume.tagline || "the open role";
  const skills = topSkills(resume);
  const bullet = strongestBullet(resume);

  const subject = `Following up: ${resume.name} — ${role} at ${companyName}`;

  const lines: string[] = [];
  lines.push(`# Cold Follow-up Email`);
  lines.push("");
  lines.push(`**Subject:** ${subject}`);
  lines.push("");
  lines.push(`Hi,`);
  lines.push("");
  lines.push(
    `My name is ${resume.name}, and I recently applied for the ${role} position at ${companyName}. I wanted to follow up directly and briefly highlight why I believe I'd be a strong fit.`
  );
  lines.push("");
  if (skills.length > 0) {
    lines.push(`My background centers on ${skills.join(", ")}.`);
  }
  if (bullet) {
    lines.push(bullet);
  }
  lines.push("");
  lines.push(
    `I've attached my resume for reference and would welcome the chance to discuss how my experience could contribute to your team. Thank you for your time and consideration.`
  );
  lines.push("");
  lines.push(`Best regards,`);
  lines.push(resume.name);
  if (resume.email) lines.push(resume.email);
  if (resume.phone) lines.push(resume.phone);

  return lines.join("\n") + "\n";
}
