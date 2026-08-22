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
