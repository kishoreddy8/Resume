import type { TransferablePair } from "../transferableSkills";

/**
 * Test-only fixture data — imported ONLY by test files, never by shipped src/lib/match modules.
 * The real TRANSFERABLE_SKILLS list ships empty in V1 (see transferableSkills.ts's doc comment);
 * these fixture pairs exist purely to exercise the TRANSFERABLE code path in isolation without
 * seeding any real-world ecosystem-adjacency claim into the shipped app.
 */
export const FIXTURE_TRANSFERABLE_PAIRS: TransferablePair[] = [
  { from: "TestSkillA", to: "TestSkillB", strength: "strong", reason: "unit test fixture — not a real approved mapping" },
  { from: "TestSkillC", to: "TestSkillB", strength: "moderate", reason: "unit test fixture — not a real approved mapping" },
];
