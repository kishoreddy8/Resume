import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { ClaudeCliTechnicalFailure, invokeClaudeWriter } from "../claudeCliInvoker";

/**
 * Stage 27 — writer failure CLASSIFICATION at the process boundary.
 *
 * Every "claude" here is a tiny fixture executable that prints a real print-mode-shaped JSON payload
 * and exits; no real, billed Claude generation ever happens. What is under test is only how CareerOps
 * reads the CLI's own report — and, critically, that the two operator-actionable classes stop
 * retrying immediately instead of burning the bounded budget.
 */

let tmpDir: string;

function writeFixture(name: string, script: string): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, script, { mode: 0o755 });
  return p;
}

/** A fixture that prints the given print-mode JSON on stdout and exits non-zero, like the real CLI. */
function failingFixture(name: string, payload: Record<string, unknown>): string {
  return writeFixture(
    name,
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(payload))});\nprocess.exit(1);\n`
  );
}

async function classify(command: string): Promise<ClaudeCliTechnicalFailure> {
  const handoffDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-s27-cli-"));
  try {
    await invokeClaudeWriter({ handoffDir, command, retryBackoffMs: 1 });
    throw new Error("expected the invocation to fail");
  } catch (err) {
    assert.ok(err instanceof ClaudeCliTechnicalFailure, `expected a technical failure, got ${String(err)}`);
    return err;
  } finally {
    fs.rmSync(handoffDir, { recursive: true, force: true });
  }
}

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-s27-fixtures-"));
});

after(() => {
  if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("S27-50 an exhausted subscription is recognised and stops retrying immediately", async () => {
  const cmd = failingFixture("fake-usage-limit.js", {
    type: "result",
    subtype: "error",
    is_error: true,
    result: "Claude usage limit reached. Your limit will reset later.",
    terminal_reason: "refusal",
  });
  const err = await classify(cmd);
  assert.equal(err.failureClass, "SUBSCRIPTION_LIMIT_REACHED");
  assert.equal(err.attempts, 1, "retrying an exhausted subscription is pure waste — it must not attempt 3 times");
  assert.equal(err.providerUnavailable, false, "this is not the provider failing to serve us");
});

test("S27-51 a logged-out CLI is recognised and stops retrying immediately", async () => {
  for (const [name, payload] of [
    ["fake-auth-text.js", { result: "Not logged in. Please run /login to continue.", terminal_reason: "refusal" }],
    ["fake-auth-401.js", { result: "unauthorized", api_error_status: 401, terminal_reason: "api_error" }],
  ] as const) {
    const err = await classify(failingFixture(name, payload as Record<string, unknown>));
    assert.equal(err.failureClass, "AUTH_REQUIRED", `${name} must classify as auth`);
    assert.equal(err.attempts, 1, "only the operator can fix this — never retry it automatically");
    assert.equal(err.providerUnavailable, false);
  }
});

test("S27-52 a provider outage is still a bounded, retried, transient failure", async () => {
  for (const status of [429, 500, 529]) {
    const err = await classify(
      failingFixture(`fake-provider-${status}.js`, {
        result: "Overloaded",
        api_error_status: status,
        terminal_reason: "api_error",
      })
    );
    assert.equal(err.failureClass, "PROVIDER_UNAVAILABLE", `HTTP ${status} is the provider, not the user`);
    assert.equal(err.providerUnavailable, true, "the pre-Stage-27 signal must keep working");
    assert.equal(err.attempts, 3, "a genuinely transient outage is worth the full bounded retry");
  }
});

test("S27-53 output problems are classified as malformed output, not as a provider or auth fault", async () => {
  const missing = writeFixture("fake-no-output.js", `#!/usr/bin/env node\nprocess.exit(0);\n`);
  const errMissing = await classify(missing);
  assert.equal(errMissing.failureClass, "MALFORMED_OUTPUT");
  assert.equal(errMissing.attempts, 3);

  const badJson = writeFixture(
    "fake-bad-json.js",
    `#!/usr/bin/env node\nrequire('fs').writeFileSync('writer_output.json', 'not json');\nprocess.exit(0);\n`
  );
  const errBad = await classify(badJson);
  assert.equal(errBad.failureClass, "MALFORMED_OUTPUT");
});

test("S27-54 an unexplained failure falls through to transient — the safe direction to be wrong in", async () => {
  const cmd = writeFixture("fake-silent-fail.js", `#!/usr/bin/env node\nprocess.exit(1);\n`);
  const err = await classify(cmd);
  assert.equal(err.failureClass, "TRANSIENT_TECHNICAL_FAILURE");
  assert.equal(err.attempts, 3, "when we cannot tell, retrying is correct — parking the workflow is not");
});

test("S27-55 a message that merely mentions limits is NOT mistaken for a subscription limit", async () => {
  // The classifier is deliberately narrow: a false positive parks an approved workflow in a state it
  // cannot leave on its own, which is worse than one more retry.
  const cmd = failingFixture("fake-not-a-limit.js", {
    result: "The context window limit was exceeded while reading the handoff files.",
    terminal_reason: "error",
  });
  const err = await classify(cmd);
  assert.equal(err.failureClass, "TRANSIENT_TECHNICAL_FAILURE");
});

test("S27-56 a successful run reports the CLI's own truthful metadata", async () => {
  const handoffDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-s27-cli-ok-"));
  const payload = {
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: "sess-123",
    duration_ms: 4242,
    num_turns: 3,
    total_cost_usd: 0.5,
    modelUsage: { "claude-opus-5[1m]": { outputTokens: 900, canonicalModel: "claude-opus-5" } },
  };
  const cmd = writeFixture(
    "fake-success-meta.js",
    `#!/usr/bin/env node\nrequire('fs').writeFileSync('writer_output.json', JSON.stringify({ ok: true }));\n` +
      `process.stdout.write(${JSON.stringify(JSON.stringify(payload))});\nprocess.exit(0);\n`
  );
  try {
    const result = await invokeClaudeWriter({ handoffDir, command: cmd, retryBackoffMs: 1 });
    assert.equal(result.attempts, 1);
    assert.ok(result.metadata);
    assert.equal(result.metadata.provider, "claude-cli");
    assert.equal(result.metadata.model, "claude-opus-5");
    assert.equal(result.metadata.sessionId, "sess-123");
    assert.equal(result.metadata.durationMs, 4242);
  } finally {
    fs.rmSync(handoffDir, { recursive: true, force: true });
  }
});

test("S27-57 a successful run whose stdout is unreadable still succeeds, with no metadata claimed", async () => {
  const handoffDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-s27-cli-nometa-"));
  const cmd = writeFixture(
    "fake-success-nometa.js",
    `#!/usr/bin/env node\nrequire('fs').writeFileSync('writer_output.json', JSON.stringify({ ok: true }));\n` +
      `process.stdout.write('not json');\nprocess.exit(0);\n`
  );
  try {
    const result = await invokeClaudeWriter({ handoffDir, command: cmd, retryBackoffMs: 1 });
    assert.equal(result.attempts, 1, "metadata is a bonus and must never fail a good result");
    assert.equal(result.metadata, null);
  } finally {
    fs.rmSync(handoffDir, { recursive: true, force: true });
  }
});
