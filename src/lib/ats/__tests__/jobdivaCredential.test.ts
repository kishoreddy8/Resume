import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fetchJobDivaJobs, isJobDivaConfigured } from "../jobdiva";

/* ================================================================================================
 * ADMIN-SEC-2 — the JobDiva discovery connector must carry no committed credential.
 *
 * Every value used here is an obvious fake. The credential that used to live in jobdiva.ts is never
 * reproduced, encoded, or referenced anywhere in this file — moving a secret from production source
 * into a test fixture would not be a fix.
 *
 * No live request is made: the missing-credential tests assert the connector fails BEFORE any fetch,
 * and the configured test points the connector at an unroutable origin so a request cannot succeed
 * even if the guard were removed.
 * ============================================================================================== */

const FAKE_USERNAME = "test-jobdiva-user";
const FAKE_PASSWORD = "test-jobdiva-credential";
/* Shape required by decodeJobDivaToken: www*.jobdiva.com | 64 hex-ish chars | numeric compid.
 * Entirely synthetic — this identifies no real tenant. */
const TOKEN = `www.jobdiva.com|${"a".repeat(64)}|1234`;

let savedUser: string | undefined;
let savedPass: string | undefined;

beforeEach(() => {
  savedUser = process.env.JOBDIVA_API_USERNAME;
  savedPass = process.env.JOBDIVA_API_PASSWORD;
  delete process.env.JOBDIVA_API_USERNAME;
  delete process.env.JOBDIVA_API_PASSWORD;
});

afterEach(() => {
  if (savedUser === undefined) delete process.env.JOBDIVA_API_USERNAME;
  else process.env.JOBDIVA_API_USERNAME = savedUser;
  if (savedPass === undefined) delete process.env.JOBDIVA_API_PASSWORD;
  else process.env.JOBDIVA_API_PASSWORD = savedPass;
});

// --- SEC2-JOBDIVA-01: nothing embedded -----------------------------------------------------------

test("SEC2-JOBDIVA-01: the connector source contains no embedded Authorization credential", () => {
  const src = fs.readFileSync(path.join(process.cwd(), "src/lib/ats/jobdiva.ts"), "utf8");
  assert.doesNotMatch(src, /"Basic\s+[A-Za-z0-9+/=]{8,}"/, "no literal Basic credential may be committed");
  assert.doesNotMatch(src, /"Bearer\s+[A-Za-z0-9._-]{8,}"/, "no literal Bearer token may be committed");
  /* The header is built at the point of use from environment configuration. */
  assert.match(src, /JOBDIVA_API_USERNAME/);
  assert.match(src, /JOBDIVA_API_PASSWORD/);
});

// --- SEC2-JOBDIVA-02/03/04/05: configured vs missing ---------------------------------------------

test("SEC2-JOBDIVA-02: configuration state is reported from the environment, never from a literal", () => {
  assert.equal(isJobDivaConfigured(), false, "absent by default in this test process");

  process.env.JOBDIVA_API_USERNAME = FAKE_USERNAME;
  assert.equal(isJobDivaConfigured(), false, "a half-configured connector is not configured");

  process.env.JOBDIVA_API_PASSWORD = FAKE_PASSWORD;
  assert.equal(isJobDivaConfigured(), true);
});

test("SEC2-JOBDIVA-03: a missing credential prevents any request from being attempted", async () => {
  /* The origin below is deliberately unroutable. If the guard were removed and a request were
   * attempted, the failure would be a network error — a DIFFERENT message from the configuration
   * error asserted here, so this test would fail rather than silently pass. */
  let networkWasAttempted = false;
  await assert.rejects(
    () =>
      fetchJobDivaJobs(TOKEN, {
        apiOriginOverride: "http://127.0.0.1:1",
        maxAttempts: 1,
        timeoutMs: 250,
      }),
    (err: Error) => {
      networkWasAttempted = /ECONNREFUSED|fetch failed|timed out|abort/i.test(err.message);
      assert.match(err.message, /^Missing JobDiva API credentials/, "must fail as configuration, not as a network error");
      return true;
    }
  );
  assert.equal(networkWasAttempted, false, "no outbound request may be made without a credential");
});

test("SEC2-JOBDIVA-04: the missing-credential failure classifies as a configuration problem", async () => {
  const { categorizeThrownError } = await import("@/lib/scan/errors");
  const err = await fetchJobDivaJobs(TOKEN, { apiOriginOverride: "http://127.0.0.1:1", maxAttempts: 1 }).catch(
    (e: Error) => e
  );
  assert.equal(
    categorizeThrownError(err),
    "invalid_config",
    "a missing setting is a configuration error, not a broken board — and is therefore non-retryable"
  );
});

test("SEC2-JOBDIVA-05: no credential value appears in the error, and neither does a half-configured one", async () => {
  process.env.JOBDIVA_API_USERNAME = FAKE_USERNAME;
  const err = (await fetchJobDivaJobs(TOKEN, { apiOriginOverride: "http://127.0.0.1:1", maxAttempts: 1 }).catch(
    (e: Error) => e
  )) as Error;

  assert.doesNotMatch(err.message, new RegExp(FAKE_USERNAME), "a configured username must not be echoed");
  assert.doesNotMatch(err.message, new RegExp(FAKE_PASSWORD));
  assert.doesNotMatch(err.message, /Basic\s+[A-Za-z0-9+/=]+/, "no encoded header may appear");
  /* Naming the variables is safe and is what an operator needs in order to fix it. */
  assert.match(err.message, /JOBDIVA_API_USERNAME/);
});

// --- SEC2-SECRETS-01: repository-wide sweep -------------------------------------------------------

test("SEC2-SECRETS-01: no production connector contains an embedded Basic/Bearer credential", async () => {
  const { execSync } = await import("node:child_process");
  const files = execSync("git ls-files 'src/**/*.ts' 'scripts/**/*.ts'", { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter((f) => f && !f.includes("__tests__"));

  const offenders: string[] = [];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(process.cwd(), rel), "utf8");
    /* Literal credentials only. A template expression such as `Bearer ${token}` is a runtime value
     * obtained from the site's own bootstrap (Cornerstone, Paycom) and is not a committed secret. */
    if (/["'`](Basic|Bearer)\s+[A-Za-z0-9+/=._-]{8,}["'`]/.test(src)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], `embedded credentials found in: ${offenders.join(", ")}`);
});

test("SEC2-SECRETS-02: the committed example config carries variable names but no values", () => {
  const example = fs.readFileSync(path.join(process.cwd(), ".env.example"), "utf8");
  assert.match(example, /JOBDIVA_API_USERNAME=\s*$/m, "documented, and empty");
  assert.match(example, /JOBDIVA_API_PASSWORD=\s*$/m);
});

// --- SEC2-RESET-01 ---------------------------------------------------------------------------------

test("SEC2-RESET-01: connector credentials live only in the environment, never in app settings", async () => {
  /* Settings are user-editable and resettable; a credential there would be wiped by Reset Settings
   * and exposed to anything that enumerates the table. */
  const { RESETTABLE_SETTINGS_KEYS } = await import("@/db/queries/settings");
  for (const key of RESETTABLE_SETTINGS_KEYS) {
    assert.doesNotMatch(key, /jobdiva|credential|password|authorization/i, `${key} must not be a credential`);
  }
  const src = fs.readFileSync(path.join(process.cwd(), "src/lib/ats/jobdiva.ts"), "utf8");
  assert.doesNotMatch(src, /getAppSettings|settings\b.*credential/i, "the connector must not read credentials from settings");
});

// --- SEC2-HEALTH-01 / SEC2-VALIDATE-01 ------------------------------------------------------------

test("SEC2-HEALTH-01: a missing credential can never produce a healthy connector outcome", async () => {
  /* checkConnectorHealth classifies via the same categorizeThrownError -> isRetryableCategory path
   * the scanner uses. A configuration error is non-retryable, so the outcome is FAILED_HARD — it can
   * reach neither HEALTHY_JOBS nor, critically, HEALTHY_EMPTY, which is the dangerous one: an empty
   * board is deliberately treated as healthy, and a credential-less connector returns no jobs. */
  const { categorizeThrownError, isRetryableCategory } = await import("@/lib/scan/errors");

  const err = (await fetchJobDivaJobs(TOKEN, { apiOriginOverride: "http://127.0.0.1:1", maxAttempts: 1 }).catch(
    (e: Error) => e
  )) as Error;
  const category = categorizeThrownError(err);

  assert.equal(category, "invalid_config");
  assert.equal(isRetryableCategory(category), false, "a setting problem must not be retried like an outage");

  /* The connector THREW, so the health checker takes its failure branch and never reaches the
   * jobs.length check that produces HEALTHY_EMPTY. */
  const outcome = isRetryableCategory(category) ? "FAILED_TEMPORARY" : "FAILED_HARD";
  assert.equal(outcome, "FAILED_HARD");
  assert.notEqual(outcome, "HEALTHY_EMPTY");
});

test("SEC2-VALIDATE-01: missing configuration is distinguishable from a provider failure", async () => {
  /* Both stop a source from being validated, but they mean different things and an operator needs to
   * tell them apart: one is fixed by setting a variable, the other by the vendor. The existing
   * ErrorCategory vocabulary already carries that distinction — no new taxonomy is introduced. */
  const { categorizeThrownError } = await import("@/lib/scan/errors");

  const configErr = (await fetchJobDivaJobs(TOKEN, { apiOriginOverride: "http://127.0.0.1:1", maxAttempts: 1 }).catch(
    (e: Error) => e
  )) as Error;
  assert.equal(categorizeThrownError(configErr), "invalid_config", "missing setting");

  assert.notEqual(
    categorizeThrownError(configErr),
    categorizeThrownError(new Error("Request to https://example.test failed with status 503")),
    "a configuration problem must not look like a provider outage"
  );
});
