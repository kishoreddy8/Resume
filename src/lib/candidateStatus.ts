/**
 * The small, shared vocabulary a candidate sees across discovery, resumes, and applications.
 *
 * This module is presentation-only. It accepts no engine objects, evaluates no gate, and contains
 * no transition logic. Feature-specific presenters remain responsible for choosing the correct key
 * from their authoritative state; once chosen, this keeps the same condition worded consistently.
 */
export type CandidateStatusKey =
  | "newMatch"
  | "readyToTailor"
  | "tailoring"
  | "needsReview"
  | "blocked"
  | "readyToUse"
  | "applicationReady"
  | "needsYourAction"
  | "inProgress"
  | "submitted"
  | "submissionUnconfirmed"
  | "closed";

export interface CandidateStatusPresentation {
  label: string;
  tone: "accent" | "info" | "warning" | "danger" | "success" | "neutral";
}

export const CANDIDATE_STATUS: Readonly<Record<CandidateStatusKey, CandidateStatusPresentation>> = {
  newMatch: { label: "New match", tone: "accent" },
  readyToTailor: { label: "Ready to tailor", tone: "success" },
  tailoring: { label: "Tailoring", tone: "info" },
  needsReview: { label: "Needs review", tone: "warning" },
  blocked: { label: "Blocked", tone: "danger" },
  readyToUse: { label: "Ready to use", tone: "success" },
  applicationReady: { label: "Application ready", tone: "success" },
  needsYourAction: { label: "Needs your action", tone: "warning" },
  inProgress: { label: "In progress", tone: "info" },
  submitted: { label: "Submitted", tone: "success" },
  submissionUnconfirmed: { label: "Submission unconfirmed", tone: "warning" },
  closed: { label: "Closed", tone: "neutral" },
};

export function candidateStatus(key: CandidateStatusKey): CandidateStatusPresentation {
  return CANDIDATE_STATUS[key];
}
