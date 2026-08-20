import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { invokeProfileBuild } from "@/lib/candidateProfileBuild/invoker";

/**
 * These never spawn the real binary. Every test either passes an explicit fixture command or
 * asserts the billing guard refuses — the same discipline the resume writer's tests follow, because
 * a forgotten fixture would otherwise perform a real, billed generation against the user's
 * subscription every time CI runs.
 */

/** A real (minimal) .docx — a zip with word/document.xml. The invoker now extracts text before
 *  spawning anything, so a text file named .docx is correctly rejected and cannot stand in. */
async function writeDocx(filePath: string, body: string): Promise<void> {
  const zip = new JSZip();
  zip.file("word/document.xml", `<w:document><w:body><w:p>${body}</w:p></w:body></w:document>`);
  fs.writeFileSync(filePath, await zip.generateAsync({ type: "nodebuffer" }));
}

async function candidateDir(withDocs: boolean): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "co-profile-build-"));
  fs.mkdirSync(path.join(dir, "master"), { recursive: true });
  if (withDocs) {
    await writeDocx(path.join(dir, "master", "resume.docx"), "Test Resume");
    await writeDocx(path.join(dir, "master", "skills.docx"), "Test Skills");
  }
  return dir;
}

function fixture(script: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "co-fixture-"));
  const bin = path.join(dir, "fake-claude");
  fs.writeFileSync(bin, `#!/bin/sh\n${script}\n`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

test("the billing guard refuses to spawn the real binary when disabled", async () => {
  const prev = process.env.CAREER_OPS_DISABLE_REAL_CLAUDE_CLI;
  process.env.CAREER_OPS_DISABLE_REAL_CLAUDE_CLI = "1";
  try {
    const res = await invokeProfileBuild({ candidateId: 1, candidateDir: await candidateDir(true) });
    assert.equal(res.ok, false);
    assert.equal(res.ok === false && res.reason, "disabled");
  } finally {
    if (prev === undefined) delete process.env.CAREER_OPS_DISABLE_REAL_CLAUDE_CLI;
    else process.env.CAREER_OPS_DISABLE_REAL_CLAUDE_CLI = prev;
  }
});

test("an explicit fixture command bypasses the guard — tests stay runnable", async () => {
  const prev = process.env.CAREER_OPS_DISABLE_REAL_CLAUDE_CLI;
  process.env.CAREER_OPS_DISABLE_REAL_CLAUDE_CLI = "1";
  try {
    const res = await invokeProfileBuild({
      candidateId: 1,
      candidateDir: await candidateDir(true),
      command: fixture("exit 0"),
    });
    assert.equal(res.ok, true);
  } finally {
    if (prev === undefined) delete process.env.CAREER_OPS_DISABLE_REAL_CLAUDE_CLI;
    else process.env.CAREER_OPS_DISABLE_REAL_CLAUDE_CLI = prev;
  }
});

test("refuses before spawning anything when the Master Resume is missing", async () => {
  const res = await invokeProfileBuild({
    candidateId: 1,
    candidateDir: await candidateDir(false),
    command: fixture("echo should-not-run; exit 0"),
  });
  assert.equal(res.ok, false);
  assert.match(res.ok === false ? res.detail : "", /Master Resume is not uploaded/);
});

test("a non-zero exit is reported rather than treated as success", async () => {
  const res = await invokeProfileBuild({
    candidateId: 1,
    candidateDir: await candidateDir(true),
    command: fixture("echo 'boom' >&2; exit 3"),
  });
  assert.equal(res.ok, false);
  assert.equal(res.ok === false && res.reason, "cli_error");
  assert.match(res.ok === false ? res.detail : "", /exit 3/);
});

test("a spawn failure is reported, not thrown", async () => {
  const res = await invokeProfileBuild({
    candidateId: 1,
    candidateDir: await candidateDir(true),
    command: "/definitely/not/a/real/binary",
  });
  assert.equal(res.ok, false);
  assert.equal(res.ok === false && res.reason, "spawn_failed");
});

test("a hung process is killed and reported as a timeout", async () => {
  const res = await invokeProfileBuild({
    candidateId: 1,
    candidateDir: await candidateDir(true),
    command: fixture("sleep 5"),
    timeoutMs: 300,
  });
  assert.equal(res.ok, false);
  assert.equal(res.ok === false && res.reason, "timeout");
});
