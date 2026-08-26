import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fetchJobDivaJobs, isJobDivaConfigured } from "../jobdiva";

/* ================================================================================================
 * ADMIN-SEC-2.1 CHECKPOINT — behavioural proof, not message-shape assertions.
 *
 * ADMIN-SEC-2 asserted that a missing credential "prevents any request" by checking that the thrown
 * message was a configuration error rather than a network one. That is inference: it proves what the
 * error said, not that the socket stayed shut. These tests replace global fetch with a spy and
 * assert the call count is exactly zero, which is the claim that actually matters.
 *
 * Every credential value here is an obvious fake. The historical credential is never reproduced,
 * decoded, or referenced. No request leaves the process: fetch is replaced before each test.
 * ============================================================================================== */

const FAKE_USERNAME = "test-jobdiva-user";
const FAKE_PASSWORD = "test-jobdiva-credential";

/* Shape demanded by decodeJobDivaToken: www*.jobdiva.com | 64 chars | numeric compid. Synthetic. */
const ACCOUNT = "a".repeat(64);
const TOKEN = `www.jobdiva.com|${ACCOUNT}|0`;

let savedUser: string | undefined;
let savedPass: string | undefined;
let realFetch: typeof globalThis.fetch;
let calls: { url: string; headers: Record<string, string> }[];

function installFetchSpy(handler?: (url: string) => unknown): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k] = v;
    calls.push({ url, headers });
    const body = handler ? handler(url) : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof globalThis.fetch;
}

beforeEach(() => {
  savedUser = process.env.JOBDIVA_API_USERNAME;
  savedPass = process.env.JOBDIVA_API_PASSWORD;
  delete process.env.JOBDIVA_API_USERNAME;
  delete process.env.JOBDIVA_API_PASSWORD;
  realFetch = globalThis.fetch;
  calls = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (savedUser === undefined) delete process.env.JOBDIVA_API_USERNAME;
  else process.env.JOBDIVA_API_USERNAME = savedUser;
  if (savedPass === undefined) delete process.env.JOBDIVA_API_PASSWORD;
  else process.env.JOBDIVA_API_PASSWORD = savedPass;
});

// --- The load-bearing proof: no configuration means no socket ------------------------------------

test("SEC2.1-JOBDIVA-01: with no configuration, ZERO fetch calls are made", async () => {
  installFetchSpy();
  const err = (await fetchJobDivaJobs(TOKEN, { maxAttempts: 1 }).catch((e: Error) => e)) as Error;

  assert.equal(calls.length, 0, "a credential-less connector must not open a connection at all");
  assert.match(err.message, /^Missing JobDiva API credentials/);
});

test("SEC2.1-JOBDIVA-02: username only — ZERO fetch calls, no malformed credential sent", async () => {
  process.env.JOBDIVA_API_USERNAME = FAKE_USERNAME;
  installFetchSpy();
  const err = (await fetchJobDivaJobs(TOKEN, { maxAttempts: 1 }).catch((e: Error) => e)) as Error;

  assert.equal(calls.length, 0, "half-configured must fail locally, never as a request");
  assert.match(err.message, /^Missing JobDiva API credentials/);
});

test("SEC2.1-JOBDIVA-03: password only — ZERO fetch calls", async () => {
  process.env.JOBDIVA_API_PASSWORD = FAKE_PASSWORD;
  installFetchSpy();
  const err = (await fetchJobDivaJobs(TOKEN, { maxAttempts: 1 }).catch((e: Error) => e)) as Error;

  assert.equal(calls.length, 0);
  assert.match(err.message, /^Missing JobDiva API credentials/);
});

// --- The configured path builds the header at runtime, from the environment ----------------------

test("SEC2.1-JOBDIVA-04: complete fake configuration produces a runtime-built Authorization header", async () => {
  process.env.JOBDIVA_API_USERNAME = FAKE_USERNAME;
  process.env.JOBDIVA_API_PASSWORD = FAKE_PASSWORD;

  installFetchSpy((url) =>
    url.includes("/auth/a")
      ? { portalID: 2038, compid: 0, a: ACCOUNT, token: "anonymous-session-token-value" }
      : { total: 0, data: [] }
  );
  await fetchJobDivaJobs(TOKEN, { maxAttempts: 1 }).catch(() => undefined);

  const bootstrap = calls.find((c) => c.url.includes("/candPortal/rest/auth/a"));
  assert.ok(bootstrap, "the bootstrap request must be attempted once configured");

  /* Derived here from the same fakes, so this proves the header is COMPUTED from configuration
   * rather than read from any surviving literal. */
  const expected = `Basic ${Buffer.from(`${FAKE_USERNAME}:${FAKE_PASSWORD}`, "utf-8").toString("base64")}`;
  assert.equal(bootstrap!.headers.Authorization, expected);
});

test("SEC2.1-JOBDIVA-04b: the header changes when configuration changes — no baked-in fallback", async () => {
  process.env.JOBDIVA_API_USERNAME = FAKE_USERNAME;
  process.env.JOBDIVA_API_PASSWORD = "a-different-fake-value";
  installFetchSpy((url) => (url.includes("/auth/a") ? { portalID: 1, compid: 0, a: ACCOUNT, token: "x".repeat(20) } : {}));
  await fetchJobDivaJobs(TOKEN, { maxAttempts: 1 }).catch(() => undefined);

  const bootstrap = calls.find((c) => c.url.includes("/auth/a"))!;
  const withOriginalPassword = `Basic ${Buffer.from(`${FAKE_USERNAME}:${FAKE_PASSWORD}`, "utf-8").toString("base64")}`;
  assert.notEqual(bootstrap.headers.Authorization, withOriginalPassword, "the header must track the environment");
});

test("SEC2.1-JOBDIVA-05: no configured value reaches the thrown error", async () => {
  process.env.JOBDIVA_API_USERNAME = FAKE_USERNAME;
  installFetchSpy();
  const err = (await fetchJobDivaJobs(TOKEN, { maxAttempts: 1 }).catch((e: Error) => e)) as Error;

  assert.doesNotMatch(err.message, new RegExp(FAKE_USERNAME));
  assert.doesNotMatch(err.message, /Basic\s+[A-Za-z0-9+/=]+/);
  assert.match(err.message, /JOBDIVA_API_USERNAME/, "naming the variable is what an operator needs");
});

// --- Health and validation cannot be satisfied by an unconfigured connector ----------------------

test("SEC2.1-HEALTH-01: missing configuration cannot reach a healthy-empty outcome", async () => {
  /* HEALTHY_EMPTY exists because a genuinely empty board is healthy. The danger is that an
   * unconfigured connector also returns no jobs. It must not: the connector THROWS, so the health
   * checker takes its failure branch and never evaluates jobs.length. */
  const { categorizeThrownError, isRetryableCategory } = await import("@/lib/scan/errors");
  installFetchSpy();

  const result = await fetchJobDivaJobs(TOKEN, { maxAttempts: 1 }).then(
    (jobs) => ({ threw: false as const, jobs }),
    (e: Error) => ({ threw: true as const, error: e })
  );

  assert.equal(calls.length, 0);
  assert.equal(result.threw, true, "it must throw, not return an empty array that reads as healthy");

  const category = categorizeThrownError(result.threw ? result.error : null);
  assert.equal(category, "invalid_config");
  assert.equal(isRetryableCategory(category), false, "a setting must not be retried like an outage");
  assert.equal(isRetryableCategory(category) ? "FAILED_TEMPORARY" : "FAILED_HARD", "FAILED_HARD");
});

test("SEC2.1-VALIDATE-01: an unconfigured connector cannot yield the job sample validation requires", async () => {
  /* Source validation approves only on a successful fetch returning at least one real job. A throw
   * cannot satisfy that, and the category distinguishes it from a provider outage. */
  const { categorizeThrownError } = await import("@/lib/scan/errors");
  installFetchSpy();
  const err = (await fetchJobDivaJobs(TOKEN, { maxAttempts: 1 }).catch((e: Error) => e)) as Error;

  assert.equal(calls.length, 0, "validation must not probe a third party over a missing setting");
  assert.equal(categorizeThrownError(err), "invalid_config");
  assert.notEqual(
    categorizeThrownError(err),
    categorizeThrownError(new Error("Request to https://example.test failed with status 503")),
    "configuration failure must remain distinguishable from provider failure"
  );
});

// --- Capability is not configuration ---------------------------------------------------------------

test("SEC2.1-CAPABILITY-01: discovery capability is static; configuration is runtime", async () => {
  const { getAtsCapability } = await import("@/lib/operations/atsCapability");
  const { DISCOVERY_CONNECTOR_PROVIDERS } = await import("@/lib/ats/scannableProviders");

  /* Unconfigured. */
  assert.equal(isJobDivaConfigured(), false);
  assert.ok(DISCOVERY_CONNECTOR_PROVIDERS.includes("jobdiva"), "the connector still exists");
  const unconfigured = getAtsCapability("jobdiva");

  /* Configured with fakes. */
  process.env.JOBDIVA_API_USERNAME = FAKE_USERNAME;
  process.env.JOBDIVA_API_PASSWORD = FAKE_PASSWORD;
  assert.equal(isJobDivaConfigured(), true);

  assert.deepEqual(
    getAtsCapability("jobdiva"),
    unconfigured,
    "capability describes what code exists and must not change with runtime configuration"
  );
  assert.equal(unconfigured.automation, "NONE", "and it remains separate from apply capability");
});

// --- Sweeps ----------------------------------------------------------------------------------------

test("SEC2.1-SECRETS-01: no production source contains a committed Basic/Bearer literal", async () => {
  const { execSync } = await import("node:child_process");
  const files = execSync("git ls-files 'src/**/*.ts' 'scripts/**/*.ts' 'tools/**/*.ts'", { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter((f) => f && !f.includes("__tests__"));

  const offenders: string[] = [];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(process.cwd(), rel), "utf8");
    /* Literals only. `Bearer ${token}` is a runtime value from the site's own bootstrap. */
    if (/["'`](Basic|Bearer)\s+[A-Za-z0-9+/=._-]{8,}["'`]/.test(src)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], `committed credentials found in: ${offenders.join(", ")}`);
});

test("SEC2.1-SECRETS-02: the credential was not relocated into any test or fixture", async () => {
  const { execSync } = await import("node:child_process");
  const tracked = execSync("git ls-files", { encoding: "utf8" }).trim().split("\n");
  const offenders: string[] = [];
  for (const rel of tracked) {
    if (!/\.(ts|tsx|js|json|md|example|env)$/.test(rel)) continue;
    let src: string;
    try {
      src = fs.readFileSync(path.join(process.cwd(), rel), "utf8");
    } catch {
      continue;
    }
    if (/["'`]Basic\s+[A-Za-z0-9+/=]{12,}["'`]/.test(src)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], `a Basic credential literal appears in: ${offenders.join(", ")}`);
});

test("SEC2.1-ENV-01: .env.example documents the variables with empty placeholders", () => {
  const example = fs.readFileSync(path.join(process.cwd(), ".env.example"), "utf8");
  assert.match(example, /^JOBDIVA_API_USERNAME=\s*$/m);
  assert.match(example, /^JOBDIVA_API_PASSWORD=\s*$/m);
  assert.doesNotMatch(example, /^JOBDIVA_API_\w+=.+$/m, "no value may be committed");
});

test("SEC2.1-ENV-02: the credential variables are server-only and never client-exposed", async () => {
  const { execSync } = await import("node:child_process");
  const src = execSync("git ls-files 'src/**/*.ts' 'src/**/*.tsx'", { encoding: "utf8" }).trim().split("\n");
  /* Test files are excluded from BOTH checks, not just the second. A suite asserting that
   * NEXT_PUBLIC_JOBDIVA is absent necessarily contains that string as an assertion literal — this
   * very file does, below — and __tests__ is never bundled for a client, so a match there is not an
   * exposure. Scanning them anyway made this test fail on itself the moment it became tracked. */
  for (const rel of src) {
    if (rel.includes("__tests__")) continue;
    const body = fs.readFileSync(path.join(process.cwd(), rel), "utf8");
    if (!/JOBDIVA_API_/.test(body)) continue;
    assert.doesNotMatch(body, /NEXT_PUBLIC_JOBDIVA/, `${rel} must not expose the credential to the client`);
    if (rel !== "src/lib/ats/jobdiva.ts") {
      assert.fail(`${rel} references the credential variables outside the connector`);
    }
  }
});
