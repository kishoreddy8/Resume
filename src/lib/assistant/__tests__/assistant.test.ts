import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { askAssistant, extractAnswer } from "../invoker";
import { buildAssistantPrompt, type AssistantContext } from "../context";

/**
 * These tests never invoke a real model.
 *
 * Every case either sets the environment guard or passes an explicit fixture command, mirroring the
 * candidate-profile invoker's own convention. A forgotten fixture here would spend the user's
 * Claude subscription every time the suite ran, so the guard is asserted directly rather than
 * assumed.
 */

function fixture(script: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "co-assist-"));
  const file = path.join(dir, "fake-claude.sh");
  fs.writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return file;
}

const CONTEXT: AssistantContext = {
  scope: "job 1 for candidate 1",
  facts: [
    "Job title: Senior Data Engineer",
    "Engine decision: NEEDS_REVIEW",
    "- Snowflake (Required) — STRONG [sources: Master Resume — Comerica; Master Skills Inventory]",
    "- Scala (Required) — NONE",
  ],
};

test("AI-1 the billing guard refuses to spawn the real binary", async () => {
  const prev = process.env.CAREER_OPS_DISABLE_REAL_CLAUDE_CLI;
  process.env.CAREER_OPS_DISABLE_REAL_CLAUDE_CLI = "1";
  try {
    const out = await askAssistant({ prompt: "hello" });
    assert.equal(out.ok, false);
    assert.equal(out.ok === false && out.reason, "disabled");
  } finally {
    if (prev === undefined) delete process.env.CAREER_OPS_DISABLE_REAL_CLAUDE_CLI;
    else process.env.CAREER_OPS_DISABLE_REAL_CLAUDE_CLI = prev;
  }
});

test("AI-2 an explicit fixture bypasses the guard, so tests stay runnable", async () => {
  const prev = process.env.CAREER_OPS_DISABLE_REAL_CLAUDE_CLI;
  process.env.CAREER_OPS_DISABLE_REAL_CLAUDE_CLI = "1";
  try {
    const out = await askAssistant({
      prompt: "hello",
      command: fixture(`echo '{"result":"Grounded answer."}'`),
    });
    assert.equal(out.ok, true);
    assert.equal(out.ok === true && out.answer, "Grounded answer.");
  } finally {
    if (prev === undefined) delete process.env.CAREER_OPS_DISABLE_REAL_CLAUDE_CLI;
    else process.env.CAREER_OPS_DISABLE_REAL_CLAUDE_CLI = prev;
  }
});

test("AI-3 a missing binary is reported, never thrown", async () => {
  const out = await askAssistant({ prompt: "hi", command: "/definitely/not/a/real/binary" });
  assert.equal(out.ok, false);
  assert.equal(out.ok === false && out.reason, "unavailable");
  assert.doesNotMatch(out.ok === false ? out.detail : "", /ENOENT|errno|spawn /, "raw system errors must not reach the UI");
});

test("AI-4 a hung assistant is killed and reported as a timeout", async () => {
  const out = await askAssistant({ prompt: "hi", command: fixture("sleep 5"), timeoutMs: 300 });
  assert.equal(out.ok, false);
  assert.equal(out.ok === false && out.reason, "timeout");
});

test("AI-5 a non-zero exit never leaks stderr into the answer", async () => {
  const out = await askAssistant({
    prompt: "hi",
    command: fixture("echo 'Error: at Object.<anonymous> (/x/y.js:1:1)' >&2; exit 3"),
  });
  assert.equal(out.ok, false);
  assert.doesNotMatch(out.ok === false ? out.detail : "", /at Object|\.js:/, "a stack trace is not a message for a user");
});

test("AI-6 an error result is not presented as an answer", () => {
  assert.equal(extractAnswer('{"is_error":true,"result":"boom"}'), null);
  assert.equal(extractAnswer(""), null);
  assert.equal(extractAnswer('{"result":"real"}'), "real");
});

test("AI-7 the prompt forbids reasoning beyond the supplied facts", () => {
  const prompt = buildAssistantPrompt("Why is this under review?", CONTEXT);
  assert.match(prompt, /Answer ONLY from the facts below/i);
  assert.match(prompt, /do not reason from general\s*\n?\s*.*knowledge/i);
  assert.match(prompt, /Never invent an employer, project, date, year, certification, score or requirement/i);
  assert.match(prompt, /do not agree, disagree, or re-decide/i);
});

test("AI-8 the prompt preserves the declared-versus-used distinction", () => {
  const prompt = buildAssistantPrompt("Where does my Snowflake evidence come from?", CONTEXT);
  assert.match(
    prompt,
    /"Available via the Master Skills Inventory" means the candidate declared the skill, NOT that/i,
    "conflating declared with used at an employer is the exact failure this assistant could cause"
  );
});

test("AI-9 every supplied fact reaches the prompt verbatim", () => {
  const prompt = buildAssistantPrompt("q", CONTEXT);
  for (const fact of CONTEXT.facts) assert.ok(prompt.includes(fact), `fact dropped: ${fact}`);
});
