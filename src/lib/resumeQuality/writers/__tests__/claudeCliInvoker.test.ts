import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { ClaudeCliTechnicalFailure, invokeClaudeWriter } from "../claudeCliInvoker";

/**
 * Never invokes a real, billed Claude CLI process — every "claude" command here is a tiny fixture
 * executable (Node script with a shebang) simulating one specific outcome (success, non-zero exit,
 * malformed JSON, missing output, or an eventually-succeeding flaky run). This is "mocking the
 * process boundary" as required: the invoker's own retry/validation logic is exercised for real, the
 * expensive external process is not.
 */

let tmpDir: string;
let handoffDir: string;

function writeFixture(name: string, script: string): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, script, { mode: 0o755 });
  return p;
}

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-cli-fixtures-"));
});

after(() => {
  if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("successful run: writes valid writer_output.json, resolves on first attempt", async () => {
  handoffDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-cli-handoff-"));
  const cmd = writeFixture(
    "fake-claude-success.js",
    `#!/usr/bin/env node\nrequire('fs').writeFileSync('writer_output.json', JSON.stringify({ ok: true }));\nprocess.exit(0);\n`
  );

  const result = await invokeClaudeWriter({ handoffDir, command: cmd, retryBackoffMs: 5 });
  assert.equal(result.attempts, 1);
  assert(fs.existsSync(path.join(handoffDir, "writer_output.json")));
  fs.rmSync(handoffDir, { recursive: true, force: true });
});

test("non-zero exit code is treated as a technical failure and retried, then exhausted", async () => {
  handoffDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-cli-handoff-"));
  const cmd = writeFixture("fake-claude-always-fails.js", `#!/usr/bin/env node\nprocess.exit(1);\n`);

  await assert.rejects(
    () => invokeClaudeWriter({ handoffDir, command: cmd, retryBackoffMs: 5 }),
    (err: unknown) => {
      assert(err instanceof ClaudeCliTechnicalFailure);
      assert.equal((err as ClaudeCliTechnicalFailure).attempts, 3, "must exhaust exactly the bounded attempt count, never more");
      return true;
    }
  );
  fs.rmSync(handoffDir, { recursive: true, force: true });
});

test("missing output file (exit 0 but nothing written) is a technical failure", async () => {
  handoffDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-cli-handoff-"));
  const cmd = writeFixture("fake-claude-missing-output.js", `#!/usr/bin/env node\nprocess.exit(0);\n`);

  await assert.rejects(() => invokeClaudeWriter({ handoffDir, command: cmd, retryBackoffMs: 5 }), ClaudeCliTechnicalFailure);
  assert.equal(fs.existsSync(path.join(handoffDir, "writer_output.json")), false);
  fs.rmSync(handoffDir, { recursive: true, force: true });
});

test("malformed JSON output is a technical failure, never trusted merely because the process exited 0", async () => {
  handoffDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-cli-handoff-"));
  const cmd = writeFixture(
    "fake-claude-malformed.js",
    `#!/usr/bin/env node\nrequire('fs').writeFileSync('writer_output.json', '{ this is not valid json');\nprocess.exit(0);\n`
  );

  await assert.rejects(() => invokeClaudeWriter({ handoffDir, command: cmd, retryBackoffMs: 5 }), ClaudeCliTechnicalFailure);
  fs.rmSync(handoffDir, { recursive: true, force: true });
});

test("bounded retry: fails twice then succeeds on the third attempt, within budget", async () => {
  handoffDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-cli-handoff-"));
  const counterFile = path.join(handoffDir, ".attempt-counter");
  fs.writeFileSync(counterFile, "0");

  const cmd = writeFixture(
    "fake-claude-eventually-succeeds.js",
    `#!/usr/bin/env node
const fs = require('fs');
const counterPath = '${counterFile.replace(/\\/g, "\\\\")}';
const n = parseInt(fs.readFileSync(counterPath, 'utf-8'), 10) + 1;
fs.writeFileSync(counterPath, String(n));
if (n < 3) { process.exit(1); }
fs.writeFileSync('writer_output.json', JSON.stringify({ ok: true, attempt: n }));
process.exit(0);
`
  );

  const result = await invokeClaudeWriter({ handoffDir, command: cmd, retryBackoffMs: 5 });
  assert.equal(result.attempts, 3);
  const output = JSON.parse(fs.readFileSync(path.join(handoffDir, "writer_output.json"), "utf-8"));
  assert.equal(output.attempt, 3);
  fs.rmSync(handoffDir, { recursive: true, force: true });
});

test("timeout is treated as a technical failure, not left hanging", async () => {
  handoffDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-cli-handoff-"));
  const cmd = writeFixture(
    "fake-claude-slow.js",
    `#!/usr/bin/env node\nsetTimeout(() => { require('fs').writeFileSync('writer_output.json', '{}'); process.exit(0); }, 5000);\n`
  );

  await assert.rejects(
    () => invokeClaudeWriter({ handoffDir, command: cmd, timeoutMs: 200, retryBackoffMs: 5 }),
    ClaudeCliTechnicalFailure
  );
  fs.rmSync(handoffDir, { recursive: true, force: true });
});

test("constructed CLI invocation never grants Bash, never bypasses permissions, always scopes to the handoff dir", async () => {
  handoffDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-cli-handoff-"));
  const argvCapturePath = path.join(handoffDir, "captured-argv.json");
  const cmd = writeFixture(
    "fake-claude-capture-argv.js",
    `#!/usr/bin/env node
require('fs').writeFileSync('${argvCapturePath.replace(/\\/g, "\\\\")}', JSON.stringify(process.argv.slice(2)));
require('fs').writeFileSync('writer_output.json', JSON.stringify({ ok: true }));
process.exit(0);
`
  );

  await invokeClaudeWriter({ handoffDir, command: cmd, retryBackoffMs: 5 });

  const argv: string[] = JSON.parse(fs.readFileSync(argvCapturePath, "utf-8"));
  const joined = argv.join(" ");

  assert(!joined.includes("Bash"), "the writer session must never be granted the Bash tool");
  assert(!joined.includes("dangerously-skip-permissions"), "must never use the broad permission bypass");
  assert(joined.includes("--tools Read,Write") || argv.includes("Read,Write"), "must restrict tools to exactly Read,Write");
  assert(argv.includes("--add-dir") && argv.includes(handoffDir), "must scope filesystem access to the handoff directory only");
  assert(argv.includes("--safe-mode"), "must disable CLAUDE.md/skills/plugins/MCP for the sandboxed writer session");

  fs.rmSync(handoffDir, { recursive: true, force: true });
});

test("a stale output file from a prior failed attempt is never mistaken for the current attempt's result", async () => {
  handoffDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-cli-handoff-"));
  // Simulate leftover output from an earlier, unrelated failed run.
  fs.writeFileSync(path.join(handoffDir, "writer_output.json"), JSON.stringify({ stale: true }));

  const cmd = writeFixture("fake-claude-always-fails-no-output.js", `#!/usr/bin/env node\nprocess.exit(1);\n`);

  await assert.rejects(() => invokeClaudeWriter({ handoffDir, command: cmd, retryBackoffMs: 5 }), ClaudeCliTechnicalFailure);
  assert.equal(fs.existsSync(path.join(handoffDir, "writer_output.json")), false, "the stale file must be cleared before each attempt");
  fs.rmSync(handoffDir, { recursive: true, force: true });
});
