/**
 * Sourced verbatim from the "GUARDRAIL — BANNED AI-SOUNDING LANGUAGE" section of the Resume
 * Tailoring System Instructions (.claude/skills/tailor-resume/SKILL.md / its Codex mirror) —
 * reused as the authoritative list, not reinvented. This module does not modify those instructions
 * or import from that file (they're prose, not a machine-readable module); it copies the same
 * already-authored word list so the deterministic reviewer checks against the SAME rule the writer
 * is instructed to follow, not a competing one.
 */
export const BANNED_PHRASES: readonly string[] = [
  "leverage",
  "utilize",
  "synergy",
  "spearheaded",
  "cutting-edge",
  "dynamic",
  "results-driven",
  "passionate",
  "seamlessly",
  "robust solution",
  "game-changing",
  "unlock",
  "elevate",
  "holistic",
];

const BANNED_PHRASE_REGEXES = BANNED_PHRASES.map(
  (phrase) => new RegExp(`(?<![\\w-])${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i")
);

const TECHNICAL_DYNAMIC_EXEMPTIONS = [
  /\bdynamic\s+(?:data\s+)?masking\b/gi,
  /\bdynamic\s+tables?\b/gi,
  /\bdynamic\s+partition(?:ing)?\b/gi,
  /\bdynamic\s+sql\b/gi,
  /\bdynamic\s+routing\b/gi,
];

/** Every banned phrase found in one bullet/sentence, in the order BANNED_PHRASES lists them
 *  (deterministic output order, not scan order). */
export function findBannedLanguage(text: string): string[] {
  const found: string[] = [];
  for (let i = 0; i < BANNED_PHRASES.length; i++) {
    const phrase = BANNED_PHRASES[i];
    let checkText = text;
    if (phrase === "dynamic") {
      for (const re of TECHNICAL_DYNAMIC_EXEMPTIONS) {
        checkText = checkText.replace(re, "");
      }
    }
    if (BANNED_PHRASE_REGEXES[i].test(checkText)) found.push(phrase);
  }
  return found;
}
