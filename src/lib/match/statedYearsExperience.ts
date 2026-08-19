import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

/**
 * The candidate's total years of experience, as EXPLICITLY STATED in their own Master Resume.
 *
 * WHY THIS EXISTS. `candidate-profile.json` is a derived index, rebuilt from scratch by the
 * build-candidate-profile skill, and that skill writes `totalYearsExperience: null` by design — the
 * app was meant to compute the figure from employment dates. For a candidate with a gap in their
 * history (here: Microgate ending 2021-11, Fiserv starting 2023-07) the interval-union math
 * correctly refuses to produce a number, so the profile recorded `null` while the Master Resume had
 * said "Data Engineer with 6 years designing, building, and maintaining production data lake and
 * data warehouse platforms" on its first line all along. A verified fact was being discarded, and
 * every generated summary then had to avoid stating years at all.
 *
 * WHAT THIS DOES NOT DO. It never calculates, infers, sums, or approximates anything from
 * employment dates — that is `computeTotalYearsExperience`'s job and it is left untouched, along
 * with every matching/ranking and truthfulness caller of it. This module reads ONE thing: a number
 * the candidate's own master evidence states in words. Absent such a statement it returns null, and
 * null continues to mean "CareerOps has no authoritative figure, so nothing may be claimed".
 *
 * It is read-only over master evidence: nothing here writes to, moves, or rewrites any file under
 * data/candidates/<id>/master/. And it is candidate-scoped by an explicit path — one candidate's
 * figure can never be read for another, because the only file consulted is that candidate's own.
 */

/**
 * "6 years", "6+ years", "over 6 years of experience", "6 years of hands-on experience".
 *
 * Deliberately anchored to an experience claim rather than matching any number followed by "years":
 * a resume says "6 years designing…" about a career and "3 years" about a single technology, and
 * only the first is a total. The qualifier group is permitted but never itself creates a figure —
 * "over 6 years" still yields exactly 6, the stated number, never a rounded-up 7.
 */
const STATED_TOTAL_YEARS = [
  // "<Role> with 6 years ..." / "with over 6+ years of hands-on experience"
  /\bwith\s+(?:over|more than|nearly|almost|about|around|roughly|approximately)?\s*(\d{1,2})\+?\s*years?\b/i,
  // "6 years of (professional|hands-on|industry) experience"
  /\b(\d{1,2})\+?\s*years?\s+of\s+(?:[a-z-]+\s+){0,3}experience\b/i,
  // "6+ years experience"
  /\b(\d{1,2})\+?\s*years?\s+experience\b/i,
];

/** Sanity bounds — a stated total outside these is a parse artefact, not a career. */
const MIN_STATED_YEARS = 1;
const MAX_STATED_YEARS = 60;

/**
 * Pure text form, so the rule is testable without any file on disk. Returns the FIRST plausible
 * stated total, because a Professional Summary states the career total in its opening line and any
 * later "N years" belongs to a specific role or technology.
 */
export function extractStatedYearsFromText(text: string): number | null {
  if (!text) return null;
  for (const pattern of STATED_TOTAL_YEARS) {
    const match = text.match(pattern);
    if (!match) continue;
    const years = Number(match[1]);
    if (!Number.isFinite(years)) continue;
    if (years < MIN_STATED_YEARS || years > MAX_STATED_YEARS) continue;
    return years;
  }
  return null;
}

/**
 * Minimal synchronous .docx text reader.
 *
 * loadCandidateProfile() is synchronous and is called on hot paths, so pulling in JSZip's async API
 * (and making every caller async) would be a far larger change than this fact is worth. A .docx is
 * a ZIP; word/document.xml is stored either uncompressed or raw-DEFLATE, both of which node's own
 * zlib reads synchronously. Anything unexpected returns null rather than throwing — a profile load
 * must never fail because an optional enrichment could not be read.
 */
function readDocxText(filePath: string): string | null {
  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch {
    return null;
  }

  // Walk local file headers (PK\x03\x04) looking for word/document.xml.
  let offset = 0;
  while (offset + 30 <= buffer.length) {
    if (buffer.readUInt32LE(offset) !== 0x04034b50) break;
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString("latin1");
    const dataStart = nameStart + nameLength + extraLength;

    if (name === "word/document.xml") {
      // A streamed entry (size in the trailing data descriptor) reports 0 here; give up rather than
      // guess at the extent, since a wrong length would yield garbage text, not an error.
      if (compressedSize === 0) return null;
      const data = buffer.subarray(dataStart, dataStart + compressedSize);
      try {
        const xml = method === 0 ? data : zlib.inflateRawSync(data);
        return xml.toString("utf-8");
      } catch {
        return null;
      }
    }
    offset = dataStart + compressedSize;
  }
  return null;
}

/** The visible text of a WordprocessingML document, in reading order. */
export function documentXmlToText(xml: string): string {
  const runs = [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]);
  return runs
    .join(" ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The stated figure from ONE candidate's master resume, or null.
 *
 * `masterDirectory` is passed in rather than derived here so this module has no opinion about path
 * layout and cannot be pointed at the wrong candidate by a defaulting rule — the caller that already
 * owns candidate-scoped paths supplies it explicitly.
 */
export function readStatedYearsExperience(masterDirectory: string): number | null {
  for (const filename of ["resume.docx", "Master_Resume.docx"]) {
    const filePath = path.join(masterDirectory, filename);
    if (!fs.existsSync(filePath)) continue;
    const xml = readDocxText(filePath);
    if (!xml) continue;
    const stated = extractStatedYearsFromText(documentXmlToText(xml));
    if (stated !== null) return stated;
  }
  return null;
}
