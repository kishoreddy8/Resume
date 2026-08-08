import type { CertificationMatch } from "./types";
import { classifyCueLine, toLines } from "./textUtils";

// Named, well-known certifications first (longest-first isn't critical here since these rarely
// overlap each other) — matched only against explicit certification language, never inferred from
// a bare technology mention ("AWS" alone never creates a certification row; "AWS Certified
// Solutions Architect" does).
const NAMED_CERTS = [
  "AWS Certified Solutions Architect",
  "AWS Certified Developer",
  "AWS Certified SysOps Administrator",
  "AWS Certified",
  "Azure Administrator",
  "Azure Solutions Architect",
  "Microsoft Certified",
  "Google Cloud Certified",
  "PMP",
  "Project Management Professional",
  "CISSP",
  "CompTIA Security+",
  "Security+",
  "Certified Kubernetes Administrator",
  "CKA",
  "Certified ScrumMaster",
  "CSM",
  "Certified Data Professional",
  "Snowflake SnowPro",
  "Databricks Certified",
];

// Word-bounded (not character-bounded) capture: up to 4 words immediately before "certification" /
// after "certified in". Two things matter here: (1) the regex has the case-insensitive flag for
// matching "certification" in any casing, which also makes a naive [A-Z] "must start capitalized"
// guard meaningless — it would match lowercase letters too — so capitalization is not relied on at
// all; (2) bounding by word count keeps the match from sweeping in unrelated filler words from
// earlier in a long block-text line ("Experience working on Cybersecurity Maturity Model
// Certification" must capture "Cybersecurity Maturity Model", not "working on Cybersecurity Maturity
// Model" — found via real-JD validation, see the backfill script's --verbose output).
const WORD = "[A-Za-z0-9.+#/]+";
const GENERIC_CERT_PATTERN = new RegExp(
  `\\b((?:${WORD}\\s+){0,2}${WORD})\\s+certification\\b|\\bcertified\\s+in\\s+((?:${WORD}\\s+){0,2}${WORD})\\b`,
  "i"
);

// Longest name first so "AWS Certified Solutions Architect" is claimed whole before the shorter
// "AWS Certified" entry can also match the same span as a separate, redundant row.
const NAMED_CERTS_BY_LENGTH = [...NAMED_CERTS].sort((a, b) => b.length - a.length);

function findNamedCertsInLine(line: string): { name: string; start: number; end: number }[] {
  const taken: { start: number; end: number }[] = [];
  const found: { name: string; start: number; end: number }[] = [];
  for (const name of NAMED_CERTS_BY_LENGTH) {
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (!taken.some((t) => start < t.end && end > t.start)) {
        taken.push({ start, end });
        found.push({ name, start, end });
      }
    }
  }
  return found;
}

export function extractCertifications(descriptionHtml: string | null, descriptionText: string | null): CertificationMatch[] {
  const lines = toLines(descriptionHtml, descriptionText);
  const byName = new Map<string, CertificationMatch>();

  for (const line of lines) {
    const level = classifyCueLine(line);
    if (!level) continue; // no requirement-level evidence — do not fabricate one

    for (const { name } of findNamedCertsInLine(line)) {
      const key = name.toLowerCase();
      if (!byName.has(key)) {
        byName.set(key, { name, requirementLevel: level, evidenceSnippet: line });
      }
    }

    const genericMatch = line.match(GENERIC_CERT_PATTERN);
    if (genericMatch) {
      const name = (genericMatch[1] ?? genericMatch[2])?.trim();
      if (name) {
        const key = name.toLowerCase();
        if (!byName.has(key)) {
          byName.set(key, { name, requirementLevel: level, evidenceSnippet: line });
        }
      }
    }
  }

  return Array.from(byName.values());
}
