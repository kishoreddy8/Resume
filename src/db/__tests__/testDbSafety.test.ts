import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getDb, getDbPath, DB_PATH } from "@/db";

/* ================================================================================================
 * ADMIN-OPS-5 — the production database must be unreachable from a test run.
 *
 * THIS SUITE DELIBERATELY DOES NOT SET CAREER_OPS_DB_PATH. That is the whole point: it stands in for
 * the test somebody writes next year without reading any of this, and it must still be incapable of
 * touching the operator's real data. Before this phase the fallback was production, so a suite like
 * this one wrote straight into data/app.db — and because getDb() memoises on a global, the first such
 * caller in a process decided the file for every later one, override or not.
 * ============================================================================================== */

const PRODUCTION_DB = path.join(process.cwd(), "data", "app.db");

test("OPS5-TESTDB-01: a test run cannot resolve to the production database", () => {
  assert.equal(process.env.CAREER_OPS_DB_PATH, undefined, "precondition: this suite sets no override");
  assert.ok(process.env.NODE_TEST_CONTEXT, "precondition: the runner marks this process as a test");

  const resolved = getDbPath();
  assert.notEqual(resolved, PRODUCTION_DB, "the fallback must never be the operator's database");
  assert.ok(resolved.startsWith(os.tmpdir()), `expected a temp path, got ${resolved}`);
  assert.equal(path.basename(resolved), "app.db", "and it is still an app.db, so schema code behaves normally");

  /* The import-time constant must agree — it is captured before any before() hook could run, which
   * is exactly why an env-var convention could not protect it. */
  assert.equal(DB_PATH, resolved, "DB_PATH must resolve through the same rule");
  assert.notEqual(DB_PATH, PRODUCTION_DB);
});

test("OPS5-TESTDB-02: opening and writing through the singleton leaves production untouched", () => {
  const before = fs.existsSync(PRODUCTION_DB) ? fs.statSync(PRODUCTION_DB).mtimeMs : null;

  /* FAIL CLOSED BEFORE WRITING. This assertion is not decoration: while checking that the fail-safe
   * had teeth, this very suite was run with the fail-safe deliberately removed — and its insert went
   * straight into the operator's database. A test that verifies isolation must never be capable of
   * destroying it when the thing it verifies is absent. */
  const target = getDbPath();
  assert.ok(target.startsWith(os.tmpdir()), `refusing to write: resolved database is not a temp file (${target})`);
  assert.notEqual(target, PRODUCTION_DB, "refusing to write to the production database");

  const db = getDb();
  db.prepare("INSERT INTO companies (name, source_type, ats_board_token, is_active) VALUES (?,?,?,1)")
    .run("SafetyProbe", "greenhouse", "tok");
  const n = (db.prepare("SELECT COUNT(*) AS n FROM companies").get() as { n: number }).n;
  assert.equal(n, 1, "the write really happened — somewhere");

  /* And that somewhere is not production. */
  assert.ok(getDbPath().startsWith(os.tmpdir()));
  const after = fs.existsSync(PRODUCTION_DB) ? fs.statSync(PRODUCTION_DB).mtimeMs : null;
  assert.equal(after, before, "the production database file was modified by a test");
});

test("OPS5-TESTDB-03: nothing in the test path deletes, resets or overwrites the production database", async () => {
  /* Isolation must never be achieved by clearing the operator's data. */
  const { execSync } = await import("node:child_process");
  const files = execSync("git ls-files 'src/**/*.ts' 'scripts/**/*.ts' 'tools/**/*.ts'", { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean);

  const offenders: string[] = [];
  for (const rel of files) {
    const body = fs.readFileSync(path.join(process.cwd(), rel), "utf8");
    /* Any destructive filesystem call naming the production database. */
    if (/(?:rmSync|unlinkSync|rmdirSync|copyFileSync|writeFileSync|truncateSync)\s*\([^)]*data\/app\.db/.test(body)) {
      offenders.push(rel);
    }
  }
  assert.deepEqual(offenders, [], "the production database must never be deleted or overwritten by code under test");
});

test("OPS5-TESTDB-04: the isolated database is private to this process", () => {
  /* node:test runs one child process per FILE, so a pid-keyed directory is per-file isolation:
   * suites cannot contaminate one another and results cannot depend on execution order. */
  const resolved = getDbPath();
  assert.match(resolved, new RegExp(`career-ops-test-${process.pid}-`), "the temp directory is keyed to this process");

  /* Repeated calls must be stable, or two callers in one process would use different databases. */
  assert.equal(getDbPath(), resolved);
  assert.equal(getDbPath(), resolved);
});

test("OPS5-COVERAGE-01: every committed test file is actually reached by `npm test`", async () => {
  /* Not a database rule, but the same class of problem and the same blast radius: the test script is
   * one long hand-maintained list of globs, and a directory missing from it fails silently — the
   * suite reports green while never running those files at all. Two committed suites
   * (src/lib/admin/__tests__) had been invisible this way, so every "full regression" in the phases
   * before this one was quietly narrower than it claimed. */
  const { execSync } = await import("node:child_process");
  const script = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")).scripts.test as string;

  /* The directory of each glob is what matters — "<dir>/*.test.ts". */
  const covered = new Set(
    (script.match(/[\w./-]+\/\*\.test\.ts/g) ?? []).map((g) => g.slice(0, g.lastIndexOf("/")))
  );

  const testFiles = execSync("git ls-files '*.test.ts'", { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  const uncovered = testFiles.filter((f) => !covered.has(path.dirname(f)));

  assert.deepEqual(
    uncovered,
    [],
    `these committed test files are never run — add their directory to the test script:\n  ${uncovered.join("\n  ")}`
  );
});

test("OPS5.1-TESTDB-05: running a test file directly, with no runner flag, is still a test runtime", async () => {
  /* Measured gap, not a hypothetical. `npx tsx path/to/x.test.ts` — the ordinary way to debug one
   * file — sets no NODE_TEST_CONTEXT, no NODE_ENV and no --test, so before ADMIN-OPS-5.1 it resolved
   * straight to the operator's database. The entry filename is the only signal available there. */
  const { execSync } = await import("node:child_process");
  const probe = path.join(process.cwd(), "ops51-direct-probe.test.ts");
  fs.writeFileSync(
    probe,
    'import { getDbPath } from "@/db";\nconsole.log(getDbPath());\n',
    "utf8"
  );
  /* The child MUST NOT inherit this process's runner variables, or it would pass on those instead of
   * on the signal under test — which is exactly how an earlier version of this test gave a false
   * green when the filename rule was removed. */
  const clean: Record<string, string | undefined> = { ...process.env };
  for (const k of ["NODE_TEST_CONTEXT", "NODE_TEST_WORKER_ID", "NODE_ENV", "CAREER_OPS_DB_PATH"]) delete clean[k];

  try {
    const out = execSync(`npx tsx ${JSON.stringify(probe)}`, { encoding: "utf8", cwd: process.cwd(), env: clean as NodeJS.ProcessEnv }).trim();
    assert.notEqual(out, PRODUCTION_DB, "direct execution must not reach the production database");
    assert.ok(out.startsWith(os.tmpdir()), `expected a temp path, got ${out}`);
  } finally {
    fs.rmSync(probe, { force: true });
  }
});

test("OPS5.1-TESTDB-06: an explicit override naming the production database fails closed", async () => {
  /* Defaulting away is not enough. An override pointing at the real file is almost certainly a
   * mistake — a copied line, or an env var leaking in from a shell — and honouring it would hand a
   * suite write access to real data. Throwing is louder than a silent redirect. */
  const { execSync } = await import("node:child_process");
  const probe = path.join(process.cwd(), "ops51-override-probe.test.ts");
  fs.writeFileSync(probe, 'import { getDbPath } from "@/db";\nconsole.log(getDbPath());\n', "utf8");
  try {
    let threw = false;
    try {
      execSync(`npx tsx ${JSON.stringify(probe)}`, {
        encoding: "utf8",
        cwd: process.cwd(),
        env: (() => {
          const e: Record<string, string | undefined> = { ...process.env, CAREER_OPS_DB_PATH: PRODUCTION_DB };
          for (const k of ["NODE_TEST_CONTEXT", "NODE_TEST_WORKER_ID", "NODE_ENV"]) delete e[k];
          return e as NodeJS.ProcessEnv;
        })(),
        stdio: "pipe",
      });
    } catch (err) {
      threw = true;
      assert.match(String((err as { stderr?: string }).stderr ?? ""), /Refusing to open the production database/);
    }
    assert.ok(threw, "resolving to the production database under test must throw, not proceed");
  } finally {
    fs.rmSync(probe, { force: true });
  }
});

test("OPS5.1-TESTDB-07: a temp override is still honoured — the escape hatch that real suites use", () => {
  /* 155 of the committed test files set their own temp path; failing closed must not break them. */
  const tmp = path.join(os.tmpdir(), "ops51-explicit.db");
  const saved = process.env.CAREER_OPS_DB_PATH;
  process.env.CAREER_OPS_DB_PATH = tmp;
  try {
    assert.equal(getDbPath(), tmp, "an explicit temp override wins");
  } finally {
    if (saved === undefined) delete process.env.CAREER_OPS_DB_PATH;
    else process.env.CAREER_OPS_DB_PATH = saved;
  }
});
