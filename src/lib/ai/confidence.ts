import type { AiConfidence, AiConfidenceBand } from "./types";

/**
 * Default per-tier-agnostic thresholds. Deliberately hardcoded constants here, NOT a Settings
 * field: settings.ts's whole design (a closed .strict() zod object, a fixed STORAGE_KEYS map with
 * one literal key per leaf field) assumes a fixed, known-in-advance schema shape — lifecycle/
 * suppression/scanner are three such fixed groups. AI tasks are an open-ended, growing set; forcing
 * per-task thresholds into that fixed-map pattern would mean editing settings.ts and its query layer
 * for every new task, which is exactly the scattered-per-feature-change this infrastructure exists to
 * avoid. If a real UI need for adjustable thresholds appears later, that's a deliberate, separate
 * addition to Settings — not a speculative one now.
 */
export const DEFAULT_CONFIDENCE_THRESHOLDS = { low: 0.5, high: 0.8 } as const;

export interface ConfidenceThresholds {
  low: number;
  high: number;
}

export function toConfidenceBand(
  value: number,
  thresholds: ConfidenceThresholds = DEFAULT_CONFIDENCE_THRESHOLDS
): AiConfidenceBand {
  if (value < thresholds.low) return "low";
  if (value < thresholds.high) return "review";
  return "high";
}

export function buildConfidence(
  value: number,
  thresholds: ConfidenceThresholds = DEFAULT_CONFIDENCE_THRESHOLDS
): AiConfidence {
  const clamped = Math.max(0, Math.min(1, value));
  return { value: clamped, band: toConfidenceBand(clamped, thresholds) };
}
