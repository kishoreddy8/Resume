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
 *
 * ISOLATION. Every entry this module touches lives under the `career-ops-ats:` service namespace
 * (enforced by `serviceName`, which every exported function routes through) and every lookup is an
 * EXACT `-s <service> -a <account>` pair — never a pattern, never a prefix scan. There is no
 * function here that enumerates or dumps the Keychain (no `dump-keychain`, no `list-keychains`
 * combined with reading entries); the only way to learn anything about an entry is to already know
 * its exact site and account. Career-Ops therefore cannot see, and this module cannot expose,
 * anything a caller did not name precisely — a credential belonging to some other application, or
 * to a different ATS/tenant/email tuple, is simply never addressed.
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

// ── PHASE 9C — tenant-scoped, multi-user-ready ATS account identity ────────────────────────────

/**
 * ONE account, scoped to exactly the levels that actually differ between accounts:
 *
 *   - `userId` — Career-Ops is single-user today, but the identity carries this dimension from the
 *     start so a later multi-user Career-Ops needs no change to this type, `ensureAuthenticated`,
 *     or any ATS adapter — only a real `userId` in place of the single-user default. Today's only
 *     caller passes `String(candidateId)`, since candidate IS the user in the current product.
 *   - `ats` + `tenant` — a candidate can legitimately hold a DIFFERENT Workday account per employer
 *     tenant, even under the same email, so identity is never bare (ats, email). `tenant` is
 *     normalized from the application URL's own hostname (see `deriveTenantKey` in `../auth`),
 *     never invented.
 *   - `email` — the authoritative candidate application email, never a personal alternate.
 *
 * This is IDENTITY SHAPE readiness for multi-user, not a multi-user implementation: no user
 * management, no auth-of-Career-Ops-itself is added anywhere in this module.
 */
export interface AtsAccountIdentity {
  userId: string;
  ats: string;
  tenant: string;
  email: string;
}

function normalizeTenant(tenant: string): string {
  return tenant.trim().toLowerCase();
}

/** The composite "site" this identity maps to. Same four values in, same Keychain entry out — a
 *  different user, ATS, or tenant is a genuinely different site, and therefore a genuinely
 *  different entry; nothing here can address an entry without providing exactly one of each. */
function identitySite(identity: AtsAccountIdentity): string {
  return `${identity.userId.trim().toLowerCase()}:${identity.ats.trim().toLowerCase()}:${normalizeTenant(identity.tenant)}`;
}

/** The database-safe reference for one identity. Not a secret; see `credentialReferenceFor`. */
export function credentialReferenceForIdentity(identity: AtsAccountIdentity): string {
  return credentialReferenceFor(identitySite(identity), identity.email);
}

/** Attribute-only existence check: `find-generic-password` WITHOUT `-w` prints the entry's
 *  metadata, never the password, so an "does a credential exist" question never touches the
 *  secret at all — not even to discard it. */
async function keychainEntryExists(site: string, account: string): Promise<boolean> {
  if (!(await isAvailable())) return false;
  try {
    await run("security", ["find-generic-password", "-s", serviceName(site), "-a", account], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * The universal shape any credential store implements: get/save/delete/exists, keyed on an
 * `AtsAccountIdentity` rather than a raw string, so a caller can never construct a lookup by hand
 * that drifts from `identitySite`'s normalization.
 */
export interface CredentialStore {
  getCredential(identity: AtsAccountIdentity): Promise<string | null>;
  saveCredential(identity: AtsAccountIdentity, secret: string): Promise<void>;
  deleteCredential(identity: AtsAccountIdentity): Promise<void>;
  exists(identity: AtsAccountIdentity): Promise<boolean>;
}

/**
 * The production store. A thin adapter over the functions above — NOT a second credential system.
 * Every method routes through the same `serviceName`/`career-ops-ats:` namespace and the same
 * exact-match `security` invocations; this object exists only to give `ensureAuthenticated` (in
 * `../engine/auth`) one interface it can swap a `FakeCredentialStore` into for tests, so no test
 * ever needs to touch a real Keychain.
 */
export const keychainCredentialStore: CredentialStore = {
  getCredential: (identity) => getPassword(identitySite(identity), identity.email),
  saveCredential: (identity, secret) => setPassword(identitySite(identity), identity.email, secret),
  deleteCredential: (identity) => deletePassword(identitySite(identity), identity.email),
  exists: (identity) => keychainEntryExists(identitySite(identity), identity.email),
};
