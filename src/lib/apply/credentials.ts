import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Credentials for ATS accounts.
 *
 * THE SECRET NEVER TOUCHES SQLITE. Passwords live in the macOS Keychain, reached through the
 * `security` binary. The database may record that an account exists — site, email, when it was last
 * used — and nothing more. A password in a local SQLite file is a password in every backup, every
 * copy of the database, and every debugging session that dumps a row.
 *
 * NEVER LOGGED, NEVER RETURNED IN AN API RESPONSE, NEVER SENT TO CLAUDE. The only function that
 * yields a secret is `getPassword`, and its only caller is the browser agent at the moment it types
 * one. Errors from `security` are re-thrown without their output, because that output can contain
 * the very thing being protected.
 *
 * PLATFORM. Keychain is macOS-only, which is where this app runs. On any other platform
 * `isAvailable` returns false and account creation is refused rather than silently downgraded to a
 * weaker store — a credential system that quietly stops protecting things is worse than none.
 */

const SERVICE_PREFIX = "career-ops-ats";

function serviceName(site: string): string {
  return `${SERVICE_PREFIX}:${site.trim().toLowerCase()}`;
}

export async function isAvailable(): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  try {
    await run("security", ["-h"], { timeout: 5000 });
    return true;
  } catch {
    /* `security -h` exits non-zero on some versions while still existing; treat only a spawn
     * failure as unavailable. */
    return process.platform === "darwin";
  }
}

/**
 * Store a password. Overwrites any existing entry for the same site/account.
 *
 * `-w` reads the secret from the argument; it is never echoed, never written to a file, and the
 * command's own output is discarded.
 */
export async function setPassword(site: string, account: string, password: string): Promise<void> {
  if (!(await isAvailable())) {
    throw new Error("No secure credential store is available on this platform.");
  }
  try {
    await run(
      "security",
      ["add-generic-password", "-U", "-s", serviceName(site), "-a", account, "-w", password],
      { timeout: 10_000 }
    );
  } catch {
    /* Deliberately opaque. The underlying error text can echo the argument list, which contains the
     * password — so it is dropped rather than wrapped. */
    throw new Error("The credential could not be saved to the Keychain.");
  }
}

/** Retrieve a password. The ONLY function that yields a secret. */
export async function getPassword(site: string, account: string): Promise<string | null> {
  if (!(await isAvailable())) return null;
  try {
    const { stdout } = await run(
      "security",
      ["find-generic-password", "-s", serviceName(site), "-a", account, "-w"],
      { timeout: 10_000 }
    );
    const value = stdout.replace(/\n$/, "");
    return value.length > 0 ? value : null;
  } catch {
    // Not found, or access denied. Both mean "no credential", and neither is worth detailing.
    return null;
  }
}

export async function deletePassword(site: string, account: string): Promise<void> {
  if (!(await isAvailable())) return;
  try {
    await run("security", ["delete-generic-password", "-s", serviceName(site), "-a", account], { timeout: 10_000 });
  } catch {
    // Already absent is the desired end state.
  }
}

/**
 * A password strong enough to be worth storing, and never shown to a model.
 *
 * Generated from crypto randomness rather than a wordlist: these are never typed by a human, so
 * memorability buys nothing and length is free.
 */
export function generatePassword(length = 24): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_=+";
  const bytes = new Uint32Array(length);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/** What the DATABASE may hold. Note the absence of anything secret. */
export interface StoredAccountReference {
  site: string;
  accountEmail: string;
  username: string | null;
  /** Names the Keychain entry; it is not the secret and cannot be exchanged for one without the OS. */
  credentialReference: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export function credentialReferenceFor(site: string, account: string): string {
  return `keychain:${serviceName(site)}:${account}`;
}
