import { escapeRegExp } from "@/lib/jobIntel/textUtils";
import { SKILL_TAXONOMY } from "@/lib/jobIntel/skillsTaxonomy";
import type { SkillCategory } from "@/types";

/**
 * Skill/technology normalization for the deterministic resume reviewer — reuses the SAME shared
 * taxonomy Phase 2 matching and job-intel extraction already use (SKILL_TAXONOMY), read-only, never
 * modified. This module never edits that shared file (which both Phase 2 and ingestion depend on —
 * out of scope for Stage 8 either way).
 *
 * A small, REVIEW-ONLY supplementary alias table below covers a few common resume-writing
 * abbreviations the shared taxonomy doesn't yet carry (documented per entry, with the exact reason).
 * These aliases only affect Stage 8's own review scoring — they are never consulted by Phase 2
 * matching, JD extraction, or candidate-profile normalization.
 *
 * NORMALIZATION STRATEGY: the shared taxonomy and the supplementary table are merged into ONE
 * combined alias list before matching, not resolved as two independent fallback passes — this
 * matters. resolveCanonicalSkill()'s own two-tier design (exact match, then longest-alias-first
 * containment) only protects specificity WITHIN its own alias list; calling it first and falling back
 * to a separate supplementary resolver only on a miss would let a shorter, more generic shared alias
 * (e.g. "aws") win a containment match against "AWS Glue" before the supplement's own more specific
 * "aws glue" entry ever gets a chance — exactly the bug this module's own tests caught during
 * development. Merging first and sorting the WHOLE list longest-alias-first (mirroring the shared
 * resolver's own ordering rationale) fixes that: "aws glue" is tried before "aws" regardless of
 * which table it came from. This is also why PySpark/Spark and Azure OpenAI/OpenAI never conflate —
 * the shared taxonomy already keeps those as separate canonical entries with no overlapping alias,
 * and merging preserves that discipline exactly.
 */

interface SupplementaryAliasEntry {
  canonical: string;
  category: SkillCategory;
  aliases: string[];
}

const REVIEW_SUPPLEMENTARY_ALIASES: SupplementaryAliasEntry[] = [
  // "ADF" is a very common resume abbreviation for Azure Data Factory that the shared taxonomy
  // doesn't carry (it only has the full phrase "azure data factory") — safe to add here because
  // "adf" as a bare 3-letter token is unambiguous in a resume/JD technical-skills context, unlike
  // the single-word aliases SKILL_TAXONOMY deliberately excludes for prose-collision reasons.
  { canonical: "Azure Data Factory", category: "Data Engineering", aliases: ["adf"] },
  // AWS Glue has no entry at all in the shared taxonomy today.
  { canonical: "AWS Glue", category: "Data Engineering", aliases: ["aws glue", "glue"] },
  // "Azure Databricks" is the Azure-branded product name for the same underlying Databricks
  // technology — the shared taxonomy's "Databricks" entry only has the bare "databricks" alias.
  { canonical: "Databricks", category: "Warehousing", aliases: ["azure databricks"] },
];

interface CombinedAliasEntry {
  canonical: string;
  category: SkillCategory;
  alias: string;
}

const COMBINED_ALIASES: CombinedAliasEntry[] = [
  ...SKILL_TAXONOMY.flatMap((entry) => entry.aliases.map((alias) => ({ canonical: entry.canonical, category: entry.category, alias }))),
  ...REVIEW_SUPPLEMENTARY_ALIASES.flatMap((entry) => entry.aliases.map((alias) => ({ canonical: entry.canonical, category: entry.category, alias }))),
].sort((a, b) => b.alias.length - a.alias.length);

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

/** Resolves a raw skill/technology mention to its canonical name against the MERGED shared +
 *  supplementary alias list — exact match first, then longest-alias-first whole-word/phrase
 *  containment. Returns null if nothing recognizes it (never guessed/fabricated). */
export function resolveSkillForReview(rawTerm: string): { canonical: string; category: SkillCategory } | null {
  const normalized = normalize(rawTerm);

  for (const { canonical, category, alias } of COMBINED_ALIASES) {
    if (normalized === alias) return { canonical, category };
  }
  for (const { canonical, category, alias } of COMBINED_ALIASES) {
    const regex = new RegExp(`(?<![\\w-])${escapeRegExp(alias)}(?![\\w-])`, "i");
    if (regex.test(normalized)) return { canonical, category };
  }
  return null;
}

/** Scans a block of free text (a bullet, a summary paragraph, a skill-group's joined items) and
 *  returns every DISTINCT canonical skill name found in it — used to build "what does this resume
 *  actually evidence" sets for ATS/keyword/skills-ordering checks. Matches longest alias first so a
 *  more specific mention (e.g. "AWS Glue") is credited to its own canonical name rather than the
 *  shorter, more generic alias it happens to contain (e.g. "AWS") also being credited. */
export function extractCanonicalSkillsFromText(text: string): Set<string> {
  const found = new Set<string>();
  const normalized = normalize(text);
  const consumed: [number, number][] = []; // [start, end) spans already claimed by a longer alias

  for (const { canonical, alias } of COMBINED_ALIASES) {
    const regex = new RegExp(`(?<![\\w-])${escapeRegExp(alias)}(?![\\w-])`, "gi");
    let match: RegExpExecArray | null;
    while ((match = regex.exec(normalized)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      const overlapsConsumed = consumed.some(([cs, ce]) => start < ce && end > cs);
      if (!overlapsConsumed) {
        found.add(canonical);
        consumed.push([start, end]);
      }
    }
  }
  return found;
}
