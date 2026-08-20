import { getCandidate } from "@/db/queries/candidates";
import { getCandidateContact, type CandidateContact } from "@/db/queries/candidateSettings";

/**
 * Stage 26B — the candidate's real contact details, validated deterministically.
 *
 * Why this exists: the resume/cover-letter renderer requires a real email
 * (tools/tailoring-engine/generate.ts), and CareerOps stored no contact details for any candidate.
 * The only values that ever reached a rendered document were the fabricated "candidate@example.com"
 * and "555-0100" injected by the pre-Stage-26 placeholder seed. Once that fabrication was correctly
 * removed, the real writer — which must never invent a hard fact — emitted empty contact fields and
 * every DOCX render failed with "resume.email is required", silently swallowed by the orchestrator.
 *
 * The rules below reject exactly the placeholder shapes that hid the problem, so a fabricated value
 * can never be re-introduced by hand through the settings UI either. Nothing here guesses, derives,
 * or defaults a value: absence is reported as absence.
 *
 * This is an INPUT/CONFIGURATION concern, never a resume-quality one. A workflow blocked here has
 * consumed no quality iteration and been judged by no reviewer — see writerWorkerCore's
 * CANDIDATE_CONTACT_REQUIRED outcome.
 */

/** Reserved-for-documentation domains (RFC 2606 / RFC 6761) plus the value the old seed used. */
const PLACEHOLDER_EMAIL_DOMAINS = ["example.com", "example.org", "example.net", "example.edu", "test.com", "invalid", "localhost"];
const PLACEHOLDER_EMAIL_LOCALPARTS = ["candidate", "youremail", "your.email", "email", "user", "someone", "firstname.lastname", "name"];

/** 555-01xx is the North American range reserved for fiction (555-0100 through 555-0199), which is
 *  precisely what the old seed used. Also catches the obvious repeated-digit fillers. */
const PLACEHOLDER_PHONE_PATTERNS = [
  /5551?0[01]\d{2}$/,
  /^0+$/,
  /^(\d)\1+$/,
  /1234567890$/,
  /0000000000$/,
];

export type ContactFieldName = "email" | "phone" | "location";

export interface ContactFieldProblem {
  field: ContactFieldName | "linkedin" | "github";
  /** Short, human-facing sentence naming exactly what must be entered or corrected. */
  message: string;
}

export interface CandidateContactValidation {
  /** True only when every field the renderer needs is present and none of them is a placeholder. */
  isComplete: boolean;
  problems: ContactFieldProblem[];
  /** Present only when isComplete — the verified values, safe to hand to the writer and renderer. */
  contact?: VerifiedCandidateContact;
}

export interface VerifiedCandidateContact {
  /** The candidate's display name, from the candidates table — not part of the editable contact
   *  configuration, but carried alongside it because the renderer requires resume.name too. */
  name: string;
  email: string;
  phone: string;
  location: string;
  /** Optional throughout — ResumeContent.linkedin is optional and the renderer never requires it. */
  linkedin?: string;
  /** Same contract as linkedin: rendered only when the candidate supplied it, never invented. */
  github?: string;
}

function normalize(raw: string | null | undefined): string {
  return (raw ?? "").trim();
}

export function isPlaceholderEmail(raw: string): boolean {
  const value = raw.trim().toLowerCase();
  const at = value.lastIndexOf("@");
  if (at === -1) return false;
  const localPart = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (PLACEHOLDER_EMAIL_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) return true;
  return PLACEHOLDER_EMAIL_LOCALPARTS.includes(localPart);
}

/** Deliberately conservative: a syntactic check only. CareerOps cannot verify that an address
 *  receives mail, and must not pretend otherwise — this rejects what is provably malformed or
 *  reserved-for-documentation, nothing more. */
export function isSyntacticallyValidEmail(raw: string): boolean {
  const value = raw.trim();
  if (/\s/.test(value)) return false;
  return /^[^@]+@[^@.]+(\.[^@.]+)+$/.test(value);
}

export function isPlaceholderPhone(raw: string): boolean {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 0) return false;
  return PLACEHOLDER_PHONE_PATTERNS.some((p) => p.test(digits));
}

/** North American / international minimum — enough digits to be dialable. Not a carrier check. */
export function hasEnoughPhoneDigits(raw: string): boolean {
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15;
}

/**
 * Validates a contact record without touching the database — the pure core, so the rules can be
 * tested and reused independently of storage.
 */
export function validateCandidateContact(input: {
  name: string;
  contact: CandidateContact;
}): CandidateContactValidation {
  const problems: ContactFieldProblem[] = [];
  const name = normalize(input.name);
  const email = normalize(input.contact.email);
  const phone = normalize(input.contact.phone);
  const location = normalize(input.contact.location);
  const linkedin = normalize(input.contact.linkedin);
  const github = normalize(input.contact.github);

  if (email.length === 0) {
    problems.push({ field: "email", message: "Email address is required — the resume renderer cannot produce a document without it." });
  } else if (!isSyntacticallyValidEmail(email)) {
    problems.push({ field: "email", message: `"${email}" is not a valid email address.` });
  } else if (isPlaceholderEmail(email)) {
    problems.push({ field: "email", message: `"${email}" is a placeholder/example address. Enter the real address a recruiter should reply to.` });
  }

  if (phone.length === 0) {
    problems.push({ field: "phone", message: "Phone number is required — it appears in the resume and cover letter header." });
  } else if (!hasEnoughPhoneDigits(phone)) {
    problems.push({ field: "phone", message: `"${phone}" does not look like a complete phone number (10-15 digits).` });
  } else if (isPlaceholderPhone(phone)) {
    problems.push({ field: "phone", message: `"${phone}" is a placeholder/reserved number. Enter the real number a recruiter should call.` });
  }

  if (location.length === 0) {
    problems.push({ field: "location", message: "Location is required — it appears in the resume and cover letter header (for example \"Dallas, TX\" or \"Remote, US\")." });
  }

  if (linkedin.length > 0 && /\s/.test(linkedin)) {
    problems.push({ field: "linkedin", message: "LinkedIn must be a URL or profile path with no spaces." });
  }

  /* Absence is never a problem — GitHub is opt-in. Only a value that cannot be a URL is, because a
   * broken link in a resume header is worse than no link at all. */
  if (github.length > 0 && /\s/.test(github)) {
    problems.push({ field: "github", message: "GitHub must be a URL or profile path with no spaces." });
  }

  if (name.length === 0) {
    problems.push({ field: "location", message: "Candidate name is missing — set the candidate's name before tailoring." });
  }

  if (problems.length > 0) return { isComplete: false, problems };
  return {
    isComplete: true,
    problems: [],
    contact: {
      name,
      email,
      phone,
      location,
      ...(linkedin.length > 0 ? { linkedin } : {}),
      ...(github.length > 0 ? { github } : {}),
    },
  };
}

/** Loads and validates the stored contact for one candidate. Never writes, never defaults. */
export function resolveCandidateContact(candidateId: number): CandidateContactValidation {
  const candidate = getCandidate(candidateId);
  if (!candidate) {
    return { isComplete: false, problems: [{ field: "email", message: `Candidate ${candidateId} not found.` }] };
  }
  const stored = getCandidateContact(candidateId);
  const name = normalize(candidate.display_name) || `${normalize(candidate.first_name)} ${normalize(candidate.last_name)}`.trim();
  return validateCandidateContact({ name, contact: stored });
}

/** One-line summary for an API/UI surface that only needs to say what is missing. */
export function describeContactProblems(validation: CandidateContactValidation): string {
  if (validation.isComplete) return "";
  return validation.problems.map((p) => p.message).join(" ");
}
