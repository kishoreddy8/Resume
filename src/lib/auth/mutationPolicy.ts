/**
 * ADMIN-SEC-1 — the declared authorization policy for every mutating API route.
 *
 * WHY A REGISTRY AND NOT A CLEVERER REGEX. The previous completeness check walked every route file
 * and skipped any whose source did not contain the literal string `candidateId`. That was sound for
 * the contract it was written to enforce — "candidate-scoped routes must call requireCandidateAccess"
 * — but it silently exempted exactly the routes that turned out to be unguarded, because a route
 * with no candidate in it mentions no candidateId. The check could not see the hole it was standing
 * next to, and its other assertion was a floor (`guarded >= 24`), which a regression cannot trip.
 *
 * The failure mode to design against is not "someone writes a route with a bad guard". It is
 * "someone adds a route and nobody thinks about its guard at all". So the registry is keyed by route
 * and the test fails on ANY mutating route that is not listed here — a new endpoint cannot merge
 * until a human has written down what protects it. Being listed is not the same as being safe, but
 * it does make the decision explicit and reviewable.
 *
 * This is deliberately a small declarative table, not a permissions framework. Career-Ops is
 * local-first single-operator software; roles, scopes and policy engines would be inventing a model
 * the product does not have.
 */

/**
 * What must protect a mutation.
 *
 * These are not severity labels — they name WHICH boundary applies, and each maps to exactly one
 * existing guard in ./guard.ts. Nothing here introduces a new authorization primitive.
 */
export type GuardType =
  /** Acts on one candidate's own data. Must call requireCandidateAccess. */
  | "CANDIDATE"
  /** Acts on global/operational state. Must call requireAdminOwner. */
  | "OPERATOR"
  /** Irreversible and owner-authorised. Must call requireOwnerAuthorization. */
  | "OWNER"
  /** Creates the resource authorization is derived from. Bootstrap-aware; see guard.ts. */
  | "PROFILE_CREATION"
  /** IS the authorization surface, so it cannot require prior authorization. Rate-limited instead. */
  | "AUTHORIZATION_SURFACE";

/** How much damage a successful unauthorised call could do. Drives review attention, not the guard. */
export type Consequence = "LOW" | "MODERATE" | "HIGH" | "CRITICAL";

export interface MutationPolicy {
  /** Route path under src/app/api, exactly as it appears on disk. */
  route: string;
  methods: readonly ("POST" | "PATCH" | "PUT" | "DELETE")[];
  guard: GuardType;
  consequence: Consequence;
  /** Why this guard, in one line. Required — an unexplained entry is not a reviewed one. */
  rationale: string;
}

/** The guard function each GuardType requires the route's source to call. */
export const REQUIRED_GUARD_SYMBOL: Record<Exclude<GuardType, "AUTHORIZATION_SURFACE">, string> = {
  CANDIDATE: "requireCandidateAccess",
  OPERATOR: "requireAdminOwner",
  OWNER: "requireOwnerAuthorization",
  PROFILE_CREATION: "requireProfileCreationAuthorization",
};

export const MUTATION_POLICIES: readonly MutationPolicy[] = [
  // --- Authorization surface -------------------------------------------------------------------
  {
    route: "candidates/[candidateId]/unlock",
    methods: ["POST", "DELETE"],
    guard: "AUTHORIZATION_SURFACE",
    consequence: "MODERATE",
    rationale: "Exchanges a PIN for an unlock token; protected by scrypt + persisted lockout, not by prior authorization.",
  },
  {
    route: "candidates/[candidateId]/pin",
    methods: ["POST", "DELETE"],
    guard: "OWNER",
    consequence: "HIGH",
    rationale: "Sets or clears a profile's only protection; owner-authorised.",
  },

  // --- Profile lifecycle -----------------------------------------------------------------------
  {
    route: "candidates",
    methods: ["POST"],
    guard: "PROFILE_CREATION",
    consequence: "MODERATE",
    rationale: "Onboarding must work on a fresh install, so protection begins once the owner sets a PIN.",
  },
  {
    route: "candidates/[candidateId]",
    methods: ["PATCH", "DELETE"],
    guard: "OWNER",
    consequence: "CRITICAL",
    rationale: "DELETE removes every row and file for a profile, irreversibly; also requires the owner to hold a PIN.",
  },
  {
    route: "candidates/active",
    methods: ["POST"],
    guard: "CANDIDATE",
    consequence: "LOW",
    rationale: "Switches the UI's active profile to one the caller can already access.",
  },

  // --- Candidate-owned data --------------------------------------------------------------------
  { route: "candidates/[candidateId]/settings", methods: ["PATCH"], guard: "CANDIDATE", consequence: "LOW", rationale: "Edits the candidate's own preferences." },
  { route: "candidates/[candidateId]/answer-memory", methods: ["PATCH"], guard: "CANDIDATE", consequence: "HIGH", rationale: "Edits stored application answers — candidate intent, never operator-writable." },
  { route: "candidates/[candidateId]/notifications/[notificationId]", methods: ["PATCH"], guard: "CANDIDATE", consequence: "LOW", rationale: "Marks one of the candidate's notifications read." },
  { route: "candidates/[candidateId]/notifications/mark-all-read", methods: ["POST"], guard: "CANDIDATE", consequence: "LOW", rationale: "Bulk read-state change on the candidate's own notifications." },
  { route: "candidates/[candidateId]/rematch", methods: ["POST"], guard: "CANDIDATE", consequence: "LOW", rationale: "Deterministic re-evaluation of the candidate's own matches; no AI, no external calls." },
  { route: "candidates/[candidateId]/build-profile", methods: ["POST"], guard: "CANDIDATE", consequence: "MODERATE", rationale: "Spawns the local Claude CLI against the candidate's own documents." },
  { route: "candidates/[candidateId]/application-runs", methods: ["POST", "PATCH"], guard: "CANDIDATE", consequence: "HIGH", rationale: "Supplies the candidate's answers and resumes a paused run; cannot submit." },
  {
    route: "candidates/[candidateId]/application-runs/start",
    methods: ["POST"],
    guard: "CANDIDATE",
    consequence: "CRITICAL",
    rationale: "The ONLY path to a browser and to submission. Submission additionally requires a run-scoped approval enforced by the state machine and the storage layer — never by this guard alone.",
  },
  { route: "candidates/[candidateId]/jobs/[jobId]/quality-workflow", methods: ["POST"], guard: "CANDIDATE", consequence: "MODERATE", rationale: "Creates a tailoring workflow for the candidate's own job." },
  { route: "candidates/[candidateId]/jobs/[jobId]/quality-workflow/approve", methods: ["POST"], guard: "CANDIDATE", consequence: "HIGH", rationale: "Human approval of a resume package; candidate authority only." },
  { route: "candidates/[candidateId]/jobs/[jobId]/quality-workflow/export", methods: ["POST"], guard: "CANDIDATE", consequence: "LOW", rationale: "Writes a handoff directory for the candidate's own workflow." },
  { route: "candidates/[candidateId]/jobs/[jobId]/quality-workflow/import", methods: ["POST"], guard: "CANDIDATE", consequence: "MODERATE", rationale: "Ingests validated writer output into the candidate's own workflow." },
  { route: "candidates/[candidateId]/jobs/[jobId]/quality-workflow/retry-writer", methods: ["POST"], guard: "CANDIDATE", consequence: "MODERATE", rationale: "Clears technical-failure bookkeeping so the writer may try again." },
  { route: "candidates/[candidateId]/jobs/[jobId]/quality-workflow/revalidate", methods: ["POST"], guard: "CANDIDATE", consequence: "LOW", rationale: "Deterministic re-review of an existing artifact; no model call." },
  { route: "candidates/[candidateId]/jobs/[jobId]/tailoring-runs", methods: ["POST"], guard: "CANDIDATE", consequence: "MODERATE", rationale: "Starts a tailoring run for the candidate's own job." },
  { route: "candidates/[candidateId]/jobs/[jobId]/tailoring-runs/[runId]", methods: ["PATCH"], guard: "CANDIDATE", consequence: "LOW", rationale: "Updates the candidate's own tailoring run." },
  { route: "master-files", methods: ["POST"], guard: "CANDIDATE", consequence: "HIGH", rationale: "Replaces the candidate's master evidence, the factual authority for all tailoring." },
  { route: "assistant", methods: ["POST"], guard: "CANDIDATE", consequence: "MODERATE", rationale: "Spends the local Claude subscription on the candidate's behalf; POST-only so prefetch cannot trigger it." },

  // --- Shared job corpus (global, not candidate-scoped) -----------------------------------------
  { route: "jobs/[id]", methods: ["PATCH"], guard: "CANDIDATE", consequence: "LOW", rationale: "Edits the caller's own per-job state (pipeline status, notes), not the shared job row." },
  { route: "jobs/[id]/match", methods: ["POST"], guard: "CANDIDATE", consequence: "LOW", rationale: "Evaluates one job for the calling candidate." },
  { route: "jobs/[id]/not-interested", methods: ["POST"], guard: "CANDIDATE", consequence: "MODERATE", rationale: "Suppresses a job for the calling candidate." },
  { route: "jobs/match-decisions", methods: ["POST"], guard: "CANDIDATE", consequence: "LOW", rationale: "Batch match decisions for the calling candidate." },
  { route: "jobs/match/batch", methods: ["POST"], guard: "CANDIDATE", consequence: "LOW", rationale: "Deterministic batch matching for the calling candidate." },
  { route: "jobs/[id]/archive", methods: ["POST"], guard: "CANDIDATE", consequence: "MODERATE", rationale: "Writes shared job-lifecycle state but is reached from the candidate product; authenticated-candidate boundary, symmetric with restore." },
  { route: "jobs/[id]/restore", methods: ["POST"], guard: "CANDIDATE", consequence: "MODERATE", rationale: "Inverse of archive and deliberately the same boundary; called from /jobs/archived in the candidate product." },
  { route: "jobs/[id]/ai-enrich", methods: ["POST", "PATCH"], guard: "CANDIDATE", consequence: "HIGH", rationale: "The only route that can spend real provider money; called from AiInsightsCard, so authentication is the fix rather than the operator boundary." },

  // --- Operator / system -----------------------------------------------------------------------
  { route: "scan", methods: ["POST"], guard: "OPERATOR", consequence: "HIGH", rationale: "Outbound requests to every allowlisted company; holds the shared scan lock." },
  { route: "production-cycle", methods: ["POST"], guard: "OPERATOR", consequence: "HIGH", rationale: "Full ingestion/scan/match orchestration under a lease." },
  { route: "settings", methods: ["PATCH"], guard: "OPERATOR", consequence: "HIGH", rationale: "Global automation configuration, including the master scheduler switch." },
  { route: "settings/reset", methods: ["POST"], guard: "OPERATOR", consequence: "HIGH", rationale: "Restores user-editable settings to defaults; must never touch secrets, leases or runtime state." },
  { route: "companies", methods: ["POST"], guard: "OPERATOR", consequence: "MODERATE", rationale: "Adds to the global company registry." },
  { route: "companies/[id]", methods: ["PATCH", "DELETE"], guard: "OPERATOR", consequence: "CRITICAL", rationale: "DELETE cascade-removes every job for the company." },
  { route: "companies/[id]/discover", methods: ["POST"], guard: "OPERATOR", consequence: "MODERATE", rationale: "Outbound discovery chain against a stored URL; server-side cooldown." },
  { route: "companies/detect", methods: ["POST"], guard: "OPERATOR", consequence: "MODERATE", rationale: "Outbound fetch chain against a caller-supplied URL; SSRF-guarded by safeFetch." },
  { route: "companies/[id]/source-proposals/[proposalId]/approve", methods: ["POST"], guard: "OPERATOR", consequence: "HIGH", rationale: "The only path that changes a company's active ATS source." },
  { route: "companies/[id]/source-proposals/[proposalId]/reject", methods: ["POST"], guard: "OPERATOR", consequence: "LOW", rationale: "Marks a proposal rejected; never touches the active source." },
];

/**
 * The guard contract future Admin repair endpoints must satisfy.
 *
 * ADMIN-OPS-4 will add routes such as /api/admin/repair/*, /api/admin/restart/*. They are global
 * operational mutations, so they take the OPERATOR boundary — requireAdminOwner — and they must be
 * registered above like everything else. Two constraints are worth stating now, while no such route
 * exists to argue with:
 *
 *   1. Being an operator does not make consequential candidate actions reachable. No repair route
 *      may submit an application, approve a resume, or write Answer Memory. Those are CANDIDATE
 *      authority plus their own run-scoped approvals, and an operator guard is not a substitute for
 *      either. ADMINSEC-SUBMIT-01 and ADMINSEC-ANSWER-01 assert this.
 *   2. A repair route may not become the second way to do something that already has a narrower
 *      path. If an action exists with a stricter guard, the repair route calls that path or does
 *      not exist.
 */
export const FUTURE_REPAIR_ROUTE_GUARD: GuardType = "OPERATOR";
