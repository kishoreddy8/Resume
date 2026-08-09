import type { CandidateExperienceEntry } from "./types";

/**
 * Total years of experience via UNION of employment date-range intervals — never a naive sum
 * (Phase 2 Revision 4 §5). Two concurrent roles (e.g. overlapping client engagements) must not be
 * double-counted as additive tenure. Entries with unparseable/missing dates are excluded from the
 * union entirely, never guessed — if nothing is parseable, the result is `null` (unknown), never 0.
 */

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

/** Accepts "YYYY-MM-DD" or "YYYY-MM" — anything else is treated as unparseable (excluded, not
 *  guessed). Deliberately strict: a fuzzy date parse could silently misplace a role's timeline. */
function parseDate(value: string): number | null {
  const isoDay = /^\d{4}-\d{2}-\d{2}$/;
  const isoMonth = /^\d{4}-\d{2}$/;
  if (isoDay.test(value)) {
    const t = Date.parse(`${value}T00:00:00Z`);
    return Number.isNaN(t) ? null : t;
  }
  if (isoMonth.test(value)) {
    const t = Date.parse(`${value}-01T00:00:00Z`);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

interface Interval {
  start: number;
  end: number;
}

export function computeTotalYearsExperience(entries: CandidateExperienceEntry[], now: Date = new Date()): number | null {
  const intervals: Interval[] = [];

  for (const entry of entries) {
    if (entry.startDate === null) continue; // unparseable/missing — excluded, never guessed
    const start = parseDate(entry.startDate);
    if (start === null) continue;
    const end = entry.endDate === null ? now.getTime() : parseDate(entry.endDate);
    if (end === null || end < start) continue; // malformed range — excluded, not guessed
    intervals.push({ start, end });
  }

  if (intervals.length === 0) return null;

  intervals.sort((a, b) => a.start - b.start);
  const merged: Interval[] = [intervals[0]];
  for (const current of intervals.slice(1)) {
    const last = merged[merged.length - 1];
    if (current.start <= last.end) {
      // Overlapping or adjacent — merge rather than double-count the shared span.
      last.end = Math.max(last.end, current.end);
    } else {
      merged.push({ ...current });
    }
  }

  const totalMs = merged.reduce((sum, interval) => sum + (interval.end - interval.start), 0);
  return Math.round((totalMs / MS_PER_YEAR) * 10) / 10; // one decimal place
}
