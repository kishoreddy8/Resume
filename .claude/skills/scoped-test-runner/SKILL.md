---
name: scoped-test-runner
description: Determine the closest/relevant tests for changed TypeScript/TSX files in career-ops-project and run only those instead of the full suite. Use when the user asks to run tests for recent changes, "run relevant tests", "test what I changed", or invokes /scoped-test-runner.
---

# How this skill works in career-ops-project

This project's `npm test` script (`package.json`) is `tsx --test <explicit file list>` — an
explicit, flat glob list of every `__tests__/*.test.ts` directory in the repo, not a
pattern-matching runner. Running it in full works but is slow when you only touched one or two
files. This skill picks the smallest correct set of test files for the current change and invokes
`tsx --test` directly against just those.

## Steps

1. **Find changed TS/TSX files.** Run `git diff --name-only` (unstaged) and `git diff --name-only
   --cached` (staged), and if the user names a base branch/commit, also `git diff --name-only
   <base>...HEAD`. Filter to `*.ts` and `*.tsx` files. If none, say so and stop — don't guess at
   "recent" changes some other way.

2. **Match each changed file to its test(s)**, using this repo's actual convention (source files
   sit next to a sibling `__tests__/` directory, e.g. `src/db/queries/jobMatches.ts` ↔
   `src/db/queries/__tests__/jobMatches.test.ts`):
   - If the changed file is itself `*.test.ts` / `*.test.tsx`, include it directly — it's already
     the test.
   - Else look for `<dir>/__tests__/<basename>.test.ts` (or `.test.tsx`) in the same directory as
     the changed file.
   - Else check one directory up for a `__tests__/` folder whose test files import the changed
     module (grep the `__tests__` directory for the changed file's basename or its `@/`-alias
     import path).
   - If nothing matches after all three checks, note the file has no covering test — don't force a
     match to an unrelated test file.

3. **Dedupe** the resulting test file list.

4. **Escalate instead of under-testing.** If a changed file is broadly-imported shared
   infrastructure — e.g. `src/db/index.ts`, shared types, `src/lib/jobIntel/skillsTaxonomy.ts`, or
   anything else where many other modules depend on it and a small scoped set can't reasonably
   bound the blast radius — fall back to the full `npm test` and explain why, rather than silently
   running a subset that might miss a break.

5. **Run only the matched files**: `npx tsx --test <matched files, space-separated>`. Do not modify
   `package.json`'s `test` script — this is a one-off invocation, not a config change.

6. **Report** which files ran and why they were selected (which changed file triggered each test),
   plus pass/fail output. If a changed file had no matching test, say that explicitly instead of
   staying silent about the gap.

## What this skill does not do

- Does not modify `package.json`, test files, or application code.
- Does not touch `data/app.db` or any database file.
- Does not replace `npm test` for pre-merge/CI verification — it's a fast local-loop tool for
  "did my change break the tests near it," not a substitute for the full suite before a PR.
