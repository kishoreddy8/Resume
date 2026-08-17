import type { CoverLetterContent, ResumeContent } from "../../../../tools/tailoring-engine/types";

/**
 * Stage 21 Phase 9 — PLACEHOLDER BLOCKER. A real generated CareerOps artifact survived to a final
 * state with "candidate@example.com", "555-0100", and "Available upon request" still in it — this
 * module exists specifically so that class of defect can never reach FINAL again.
 *
 * Deliberately generic rather than a list of the exact examples observed: pattern families (not
 * literal strings) so a differently-worded placeholder the writer invents next time is still caught.
 * Never auto-fills a "fixed" value — the correct remediation for a genuinely unavailable optional
 * field (e.g. no LinkedIn) is to OMIT it, never to manufacture one, so this module only detects and
 * reports; it never mutates content.
 */

export interface PlaceholderFinding {
  field: string;
  value: string;
  reason: string;
}

// Bracket/template placeholder syntax: [EMAIL], {{phone}}, <placeholder>, ${var} — any of these
// wrapper styles around any inner text, since the wrapper itself is the tell, not the specific word.
const WRAPPER_PLACEHOLDER_RE = /\[[A-Za-z0-9_ ]{2,30}\]|\{\{[^}]{1,60}\}\}|<[A-Za-z0-9_ ]{2,30}>|\$\{[^}]{1,60}\}/;

// Common "no real value was ever filled in" tokens, matched as whole words/phrases so e.g. a genuine
// company named "Todo Inc" or a bullet mentioning a "to-do tracking" tool don't false-positive.
const SENTINEL_WORD_RE = /\b(TBD|TODO|N\/A|NA|FIXME|XXX|PLACEHOLDER|LOREM\s+IPSUM|INSERT\s+\w+\s+HERE|YOUR\s+(NAME|EMAIL|PHONE|LINKEDIN)|CANDIDATE\s+NAME)\b/i;

// "Available upon request" and its common variants — the exact failure observed, generalized to the
// pattern (any contact-adjacent field reduced to a deferral phrase instead of a real value or omission).
const DEFERRAL_PHRASE_RE = /available\s+(upon|on)\s+request|will\s+provide\s+(upon|on)\s+request|contact\s+(info(rmation)?\s+)?upon\s+request/i;

// Canonical example/placeholder domains and numbers used in documentation/templates everywhere —
// these are near-certain signs a real value was never substituted in, not a coincidental match.
const EXAMPLE_EMAIL_RE = /@(example|test|sample|placeholder|domain|yourcompany|company)\.(com|org|net)\b/i;
const EXAMPLE_PHONE_RE = /\b(555-01\d{2}|\(555\)\s?01\d{2}|555\.01\d{2}|000-000-0000|123-456-7890|\(000\)\s?000-0000)\b/;

function scanValue(field: string, value: string | undefined | null): PlaceholderFinding[] {
  if (!value) return [];
  const findings: PlaceholderFinding[] = [];
  if (WRAPPER_PLACEHOLDER_RE.test(value)) {
    findings.push({ field, value, reason: "Contains unresolved template/bracket placeholder syntax." });
  }
  if (SENTINEL_WORD_RE.test(value)) {
    findings.push({ field, value, reason: "Contains a sentinel placeholder word (TBD/TODO/N-A/etc.)." });
  }
  if (DEFERRAL_PHRASE_RE.test(value)) {
    findings.push({ field, value, reason: 'Contains a deferral phrase ("available upon request") instead of a real value or omission.' });
  }
  if (EXAMPLE_EMAIL_RE.test(value)) {
    findings.push({ field, value, reason: "Uses a documentation/example email domain, not a real address." });
  }
  if (EXAMPLE_PHONE_RE.test(value)) {
    findings.push({ field, value, reason: "Uses a documentation/example phone number, not a real number." });
  }
  return findings;
}

function scanResume(resume: ResumeContent): PlaceholderFinding[] {
  const findings: PlaceholderFinding[] = [
    ...scanValue("resume.name", resume.name),
    ...scanValue("resume.tagline", resume.tagline),
    ...scanValue("resume.location", resume.location),
    ...scanValue("resume.phone", resume.phone),
    ...scanValue("resume.email", resume.email),
    ...scanValue("resume.linkedin", resume.linkedin),
  ];
  resume.summary.forEach((s, i) => findings.push(...scanValue(`resume.summary[${i}]`, s)));
  resume.skillGroups.forEach((g, gi) => {
    findings.push(...scanValue(`resume.skillGroups[${gi}].label`, g.label));
    g.items.forEach((item, ii) => findings.push(...scanValue(`resume.skillGroups[${gi}].items[${ii}]`, item)));
  });
  resume.experience.forEach((e, ei) => {
    findings.push(...scanValue(`resume.experience[${ei}].title`, e.title));
    findings.push(...scanValue(`resume.experience[${ei}].company`, e.company));
    findings.push(...scanValue(`resume.experience[${ei}].dates`, e.dates));
    e.bullets.forEach((b, bi) => findings.push(...scanValue(`resume.experience[${ei}].bullets[${bi}]`, b)));
  });
  resume.education.forEach((e, i) => findings.push(...scanValue(`resume.education[${i}]`, e)));
  (resume.certifications ?? []).forEach((c, i) => findings.push(...scanValue(`resume.certifications[${i}]`, c)));
  return findings;
}

function scanCoverLetter(coverLetter: CoverLetterContent): PlaceholderFinding[] {
  const findings: PlaceholderFinding[] = [
    ...scanValue("coverLetter.name", coverLetter.name),
    ...scanValue("coverLetter.location", coverLetter.location),
    ...scanValue("coverLetter.phone", coverLetter.phone),
    ...scanValue("coverLetter.email", coverLetter.email),
    ...scanValue("coverLetter.linkedin", coverLetter.linkedin),
    ...scanValue("coverLetter.salutation", coverLetter.salutation),
    ...scanValue("coverLetter.closing", coverLetter.closing),
  ];
  coverLetter.paragraphs.forEach((p, i) => findings.push(...scanValue(`coverLetter.paragraphs[${i}]`, p)));
  return findings;
}

export function evaluatePlaceholderIntegrity(resume: ResumeContent, coverLetter: CoverLetterContent | undefined): PlaceholderFinding[] {
  return [...scanResume(resume), ...(coverLetter ? scanCoverLetter(coverLetter) : [])];
}
