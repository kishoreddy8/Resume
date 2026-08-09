/**
 * Per-Requirement-Unit credit table — the ONLY place evidence strength is converted into a score
 * contribution (Phase 2 Revision 3 §5 / Revision 4 §9). V1 HYPOTHESES, not empirically validated —
 * centrally versioned here, folded into matchKnowledgeHash.ts's automatic cache-invalidation hash so
 * editing any of these values invalidates cached results without relying on a manual version bump.
 * Revisit after running the deterministic engine against real jobs in data/app.db.
 */
export const CREDIT = {
  employerExact: 1.0,
  inventoryExact: 0.6,
  /** Reduced credit when the requirement unit's evidence carries an explicit hands-on/production
   *  cue (see handsOnCues.ts) — inventory-only knowledge explicitly does not satisfy an explicit
   *  "hands-on production experience" ask, per the Master Skills Rule already codified in
   *  tailor-resume/SKILL.md. */
  inventoryExactExperienceDepthRequired: 0.3,
  transferableStrong: 0.5,
  transferableModerate: 0.35,
  missing: 0,
  unresolved: 0,
} as const;
