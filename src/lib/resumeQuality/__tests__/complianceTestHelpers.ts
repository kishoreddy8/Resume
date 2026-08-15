import { currentInstructionIdentity } from "../canonicalInstructions";
import { INSTRUCTION_COMPLIANCE_CHECK_NAMES, type InstructionComplianceChecks, type InstructionComplianceResult } from "../types";

/**
 * Shared test-only helper — a hand-built InstructionComplianceResult where every one of the 22
 * canonical checks is PASS, matching the CURRENT canonical instruction identity. Every existing
 * pre-hardening test that hand-constructs a "perfect"/READY-reaching StructuredResumeReview needs
 * this attached (evaluateQualityGate() now requires instructionCompliance to be present, current, and
 * fully PASS — see qualityGate.ts's own doc comment) — this is that one shared fixture rather than
 * 22 checks duplicated inline across every affected test file.
 */
export function fullyCompliantInstructionCompliance(overrides: Partial<InstructionComplianceChecks> = {}): InstructionComplianceResult {
  const checks = Object.fromEntries(INSTRUCTION_COMPLIANCE_CHECK_NAMES.map((name) => [name, "PASS" as const])) as unknown as InstructionComplianceChecks;
  return { ...currentInstructionIdentity(), checks: { ...checks, ...overrides }, notes: [] };
}
