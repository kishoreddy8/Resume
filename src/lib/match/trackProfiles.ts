import type { SkillCategory } from "@/types";
import type { ResumeTrack } from "./types";

/**
 * Curated resume-track profiles (Phase 2 Revision 4 §11 — deterministic track recommendation,
 * kept as a V1 heuristic, architecture open to later title/specific-technology signals). V1
 * populates only `category_distribution` signals; `title_keyword`/`specific_technology` are typed
 * now so a later revision is additive (new signal entries + one new scoring branch in
 * trackRecommendation.ts), not a reshaped interface.
 *
 * Track recommendation is PURELY INFORMATIONAL — it never feeds back into overallScore (see
 * scoring.ts's dimension list, which deliberately excludes any ecosystem/track dimension to avoid
 * double-counting the same job_skills category distribution Required/Preferred Coverage already
 * consume).
 */

export interface TrackSignal {
  kind: "category_distribution" | "title_keyword" | "specific_technology";
  weight: number;
  category?: SkillCategory; // used by category_distribution signals
}

export interface TrackProfile {
  track: ResumeTrack;
  signals: TrackSignal[];
}

export const TRACK_PROFILES: TrackProfile[] = [
  {
    track: "Azure Data Engineer",
    signals: [
      { kind: "category_distribution", category: "Cloud Platforms", weight: 1 },
      { kind: "category_distribution", category: "Data Engineering", weight: 1 },
      { kind: "category_distribution", category: "Orchestration", weight: 0.7 },
    ],
  },
  {
    track: "Snowflake Data Engineer",
    signals: [
      { kind: "category_distribution", category: "Warehousing", weight: 1 },
      { kind: "category_distribution", category: "Data Engineering", weight: 0.7 },
    ],
  },
  {
    track: "Azure Databricks Engineer",
    signals: [
      { kind: "category_distribution", category: "Warehousing", weight: 0.8 },
      { kind: "category_distribution", category: "Cloud Platforms", weight: 0.6 },
      { kind: "category_distribution", category: "Data Engineering", weight: 0.8 },
    ],
  },
  {
    track: "AI Engineer",
    signals: [{ kind: "category_distribution", category: "AI / ML", weight: 1 }],
  },
  {
    track: "Data Engineer",
    signals: [
      { kind: "category_distribution", category: "Data Engineering", weight: 1 },
      { kind: "category_distribution", category: "Databases", weight: 0.5 },
    ],
  },
];
