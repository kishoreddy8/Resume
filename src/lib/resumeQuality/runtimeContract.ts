import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Operational contract for the long-lived resume writer.
 *
 * This is intentionally separate from the canonical instruction version. The latter describes the
 * review standard; this value describes the code-level handoff/orchestration contract a process has
 * loaded. Increment it whenever a producer/worker compatibility break would make mixed modules
 * unsafe. Capturing the source revision at MODULE LOAD is important: a worker that survives a git
 * update retains the old value and can therefore reject work created by the newly loaded API.
 */
export const RESUME_WRITER_RUNTIME_CONTRACT_VERSION = "surgical-repair-v1";
export const RUNTIME_CONTRACT_FILENAME = "runtime_contract.json";

export interface ResumeWriterRuntimeContract {
  schemaVersion: 1;
  contractVersion: string;
  sourceRevision: string;
  loadedAt: string;
}

function resolveSourceRevision(): string {
  const supplied =
    process.env.CAREER_OPS_SOURCE_REVISION ??
    process.env.VERCEL_GIT_COMMIT_SHA ??
    process.env.GITHUB_SHA;
  if (supplied?.trim()) return supplied.trim();
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

const MODULE_RUNTIME_CONTRACT: ResumeWriterRuntimeContract = Object.freeze({
  schemaVersion: 1,
  contractVersion: RESUME_WRITER_RUNTIME_CONTRACT_VERSION,
  sourceRevision: resolveSourceRevision(),
  loadedAt: new Date().toISOString(),
});

/**
 * ADVISORY ONLY — never used to gate a writer pass. `MODULE_RUNTIME_CONTRACT` above is frozen at
 * module load and is the thing every real writer pass is actually checked against (see
 * assertResumeWriterRuntimeContract); that per-workflow enforcement remains fully authoritative and
 * is completely untouched by this function.
 *
 * What this adds is purely observational: in a long-lived single dev-server process, the loaded
 * contract can quietly fall behind as commits land, and nothing previously told an operator that had
 * happened until a real workflow's stamped runtime_contract.json revealed it after the fact. This
 * re-resolves the current on-disk revision FRESH on each call (via the same resolveSourceRevision()
 * a fresh process would use) so Admin can show the operator the gap before it costs a writer pass.
 *
 * Cached briefly (30s) so a busy Admin page cannot turn this into a `git rev-parse` on every request
 * — an operator watching for a restart does not need sub-second precision.
 */
let cachedObservation: { revision: string; observedAt: number } | null = null;
const OBSERVATION_CACHE_MS = 30_000;

export function observeCurrentRepositoryRevision(): { revision: string; observedAt: string } {
  const now = Date.now();
  if (!cachedObservation || now - cachedObservation.observedAt > OBSERVATION_CACHE_MS) {
    cachedObservation = { revision: resolveSourceRevision(), observedAt: now };
  }
  return { revision: cachedObservation.revision, observedAt: new Date(cachedObservation.observedAt).toISOString() };
}

export type RuntimeFreshnessState = "CURRENT" | "STALE_PROCESS" | "UNKNOWN";

export interface RuntimeFreshness {
  state: RuntimeFreshnessState;
  loadedRevision: string;
  observedRevision: string;
  observedAt: string;
  detail: string;
}

/** Compares what THIS process loaded against what is on disk right now. Never infers "safe" from a
 *  match here — the per-workflow stamp/assert cycle remains the only real safety mechanism. */
export function evaluateRuntimeFreshness(
  loaded: Pick<ResumeWriterRuntimeContract, "sourceRevision">,
  observed: { revision: string; observedAt: string } = observeCurrentRepositoryRevision()
): RuntimeFreshness {
  if (loaded.sourceRevision === "unknown" || observed.revision === "unknown") {
    return {
      state: "UNKNOWN",
      loadedRevision: loaded.sourceRevision,
      observedRevision: observed.revision,
      observedAt: observed.observedAt,
      detail: "The repository revision could not be determined; freshness cannot be judged.",
    };
  }
  if (loaded.sourceRevision !== observed.revision) {
    return {
      state: "STALE_PROCESS",
      loadedRevision: loaded.sourceRevision,
      observedRevision: observed.revision,
      observedAt: observed.observedAt,
      detail: "This process loaded an older revision than what is currently checked out. Restart every Career-Ops writer-capable process before running the writer.",
    };
  }
  return {
    state: "CURRENT",
    loadedRevision: loaded.sourceRevision,
    observedRevision: observed.revision,
    observedAt: observed.observedAt,
    detail: "This process's loaded revision matches the currently checked-out repository HEAD.",
  };
}

export class ResumeWriterRuntimeMismatchError extends Error {
  readonly code = "RUNTIME_VERSION_MISMATCH";

  constructor(message: string) {
    super(message);
    this.name = "ResumeWriterRuntimeMismatchError";
  }
}

export function getLoadedResumeWriterRuntimeContract(): ResumeWriterRuntimeContract {
  return { ...MODULE_RUNTIME_CONTRACT };
}

function contractPath(workspaceDirectory: string): string {
  return path.join(workspaceDirectory, RUNTIME_CONTRACT_FILENAME);
}

function isRuntimeContract(value: unknown): value is ResumeWriterRuntimeContract {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ResumeWriterRuntimeContract>;
  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.contractVersion === "string" &&
    candidate.contractVersion.length > 0 &&
    typeof candidate.sourceRevision === "string" &&
    candidate.sourceRevision.length > 0 &&
    typeof candidate.loadedAt === "string" &&
    candidate.loadedAt.length > 0
  );
}

export function readResumeWriterRuntimeContract(workspaceDirectory: string): ResumeWriterRuntimeContract | null {
  const file = contractPath(workspaceDirectory);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return isRuntimeContract(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function mismatchReason(expected: ResumeWriterRuntimeContract, actual: ResumeWriterRuntimeContract): string | null {
  if (expected.contractVersion !== actual.contractVersion) {
    return `workflow contract ${expected.contractVersion} does not match worker contract ${actual.contractVersion}`;
  }
  if (expected.sourceRevision !== actual.sourceRevision) {
    return `workflow source ${expected.sourceRevision} does not match worker source ${actual.sourceRevision}`;
  }
  return null;
}

/** Refuses mixed-version processing. It performs no workflow/quality mutation. */
export function assertResumeWriterRuntimeContract(
  workspaceDirectory: string,
  actual: ResumeWriterRuntimeContract = MODULE_RUNTIME_CONTRACT
): ResumeWriterRuntimeContract {
  const expected = readResumeWriterRuntimeContract(workspaceDirectory);
  if (!expected) {
    throw new ResumeWriterRuntimeMismatchError(
      `Missing or invalid ${RUNTIME_CONTRACT_FILENAME}; refusing to process an unauditable writer handoff.`
    );
  }
  const reason = mismatchReason(expected, actual);
  if (reason) {
    throw new ResumeWriterRuntimeMismatchError(`${reason}. Restart every Career-Ops writer-capable process.`);
  }
  return expected;
}

/**
 * Writes the immutable producer stamp. A pre-existing stamp is never overwritten: the caller must
 * prove compatibility with it instead. `adoptIfMissing` is reserved for workflows created before
 * this mechanism existed; the current worker stamps them once before any writer transmission.
 */
export function ensureResumeWriterRuntimeContract(
  workspaceDirectory: string,
  options: {
    runtime?: ResumeWriterRuntimeContract;
    adoptIfMissing?: boolean;
  } = {}
): ResumeWriterRuntimeContract {
  const runtime = options.runtime ?? MODULE_RUNTIME_CONTRACT;
  const existing = readResumeWriterRuntimeContract(workspaceDirectory);
  if (existing) {
    const reason = mismatchReason(existing, runtime);
    if (reason) {
      throw new ResumeWriterRuntimeMismatchError(`${reason}. Restart every Career-Ops writer-capable process.`);
    }
    return existing;
  }
  if (fs.existsSync(contractPath(workspaceDirectory)) || options.adoptIfMissing === false) {
    throw new ResumeWriterRuntimeMismatchError(
      `Missing or invalid ${RUNTIME_CONTRACT_FILENAME}; refusing to process an unauditable writer handoff.`
    );
  }
  fs.mkdirSync(workspaceDirectory, { recursive: true });
  try {
    fs.writeFileSync(contractPath(workspaceDirectory), `${JSON.stringify(runtime, null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    // Another process may have won the immutable create. Read and compare that exact value.
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
  }
  return assertResumeWriterRuntimeContract(workspaceDirectory, runtime);
}
