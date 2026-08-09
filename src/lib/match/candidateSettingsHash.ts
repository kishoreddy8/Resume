import crypto from "node:crypto";
import type { AppSettings } from "@/lib/settings";

/** Hash of the candidate's OWN eligibility facts (Settings > Candidate) — folded into the match
 *  cache key alongside candidateProfileHash/matchKnowledgeHash/jdContentHash (Phase 2 Revision 4
 *  §3): toggling requiresSponsorship/clearance/etc. is scoring-relevant knowledge too, and neither
 *  the resume/skills file hash nor the code-adjacent data hash would otherwise catch it. */
export function computeCandidateSettingsHash(candidate: AppSettings["candidate"]): string {
  return crypto.createHash("sha256").update(JSON.stringify(candidate)).digest("hex");
}
