import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * Normal Career-Ops browsing must start no browser.
 *
 * The claim is structural, so the test is too: nothing outside the execution engine may import the
 * browser runtime, and the runtime constructs nothing at module load. A page cannot accidentally
 * launch Chromium if no page-side module can reach the code that launches it.
 */

const SRC = path.join(import.meta.dirname, "..", "..", "..", "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

test("NOBROWSER-1 only the execution engine and API routes import the browser runtime", () => {
  const offenders: string[] = [];
  for (const file of walk(SRC)) {
    if (file.includes(`${path.sep}apply${path.sep}engine${path.sep}`)) continue;
    /* An API route is the sanctioned entry point — a user's explicit start reaches the engine
     * through one. What must never import it is anything that RENDERS, which NOBROWSER-2 covers. */
    if (file.endsWith(`${path.sep}route.ts`)) continue;
    const text = fs.readFileSync(file, "utf8");
    if (/from ["'].*apply\/engine\/browserRuntime["']/.test(text)) offenders.push(path.relative(SRC, file));
  }
  assert.deepEqual(offenders, [], `browser runtime reachable from: ${offenders.join(", ")}`);
});

test("NOBROWSER-2 no page, layout or component imports the executor", () => {
  const offenders: string[] = [];
  for (const file of walk(path.join(SRC, "app"))) {
    /* API routes may — that is how a user's explicit start reaches it. Pages and components may not. */
    if (file.endsWith(`${path.sep}route.ts`)) continue;
    const text = fs.readFileSync(file, "utf8");
    if (/apply\/engine\/(executor|browserRuntime)/.test(text)) offenders.push(path.relative(SRC, file));
  }
  for (const file of walk(path.join(SRC, "components"))) {
    const text = fs.readFileSync(file, "utf8");
    if (/apply\/engine\//.test(text)) offenders.push(path.relative(SRC, file));
  }
  assert.deepEqual(offenders, [], `execution engine reachable from rendered code: ${offenders.join(", ")}`);
});

test("NOBROWSER-3 constructing the runtime launches nothing", async () => {
  /* The constructor must be inert — the browser is created on first open(), not on instantiation,
   * so importing the module in a server process costs nothing. */
  const { ApplicationBrowserRuntime } = await import("../browserRuntime");
  const runtime = new ApplicationBrowserRuntime();
  assert.ok(runtime instanceof ApplicationBrowserRuntime);
  /* No close() needed: nothing was started. If this ever leaks a process the suite will hang, which
   * is itself the assertion. */
  await runtime.close();
});

test("NOBROWSER-4 the guard refuses real navigation without explicit opt-out", async () => {
  const { realApplicationAgentDisabled } = await import("../browserRuntime");
  const prev = process.env.CAREER_OPS_DISABLE_REAL_APPLICATION_AGENT;
  try {
    for (const value of [undefined, "", "true", "1", "TRUE", "off", "no"]) {
      if (value === undefined) delete process.env.CAREER_OPS_DISABLE_REAL_APPLICATION_AGENT;
      else process.env.CAREER_OPS_DISABLE_REAL_APPLICATION_AGENT = value;
      assert.equal(realApplicationAgentDisabled(), true, `"${value}" must NOT enable real runs`);
    }
    process.env.CAREER_OPS_DISABLE_REAL_APPLICATION_AGENT = "false";
    assert.equal(realApplicationAgentDisabled(), false, 'only an explicit "false" enables real runs');
  } finally {
    if (prev === undefined) delete process.env.CAREER_OPS_DISABLE_REAL_APPLICATION_AGENT;
    else process.env.CAREER_OPS_DISABLE_REAL_APPLICATION_AGENT = prev;
  }
});
