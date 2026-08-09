---
name: build-candidate-profile
description: Rebuild the derived candidate-profile.json index from a specific candidate's Master Resume and Master Skills Inventory, for career-ops-project's Phase 2 job-matching engine. Use when the user asks to build/rebuild/refresh a candidate profile, or after uploading a new Master Resume/Skills Inventory, or invokes /build-candidate-profile <candidate_id>.
---

# How this skill works in career-ops-project

Phase 2's deterministic matching engine (`src/lib/match/`) needs a normalized, versioned index of
what the candidate knows and has done, without re-parsing the Master Resume/Skills Inventory `.docx`
files on every job evaluation. This skill builds that index. **It is the only V1 workflow that
produces `data/candidates/<candidate_id>/candidate-profile.json`** — the app itself has no
`.docx`-text-extraction code and never should; that reasoning stays here, in Claude Code, the same
way `tailor-resume` already keeps deep resume reasoning out of the in-app AI layer.

**Run this whenever the Master Resume or Master Skills Inventory changes** (re-upload via
`/master-files`) — the matching engine detects staleness by comparing this file's recorded source
hashes against the current upload manifest and refuses to produce a result (never `READY_FOR_TAILORING`,
never any decision at all) when they don't match.

## Invocation contract — Phase 2.5, candidate-scoped

Invoked as `/build-candidate-profile <candidate_id>` — `candidate_id` is required and must match a
row in the `candidates` table (`data/app.db`). If no `candidate_id` is given, ask the user which
candidate before doing anything else — **never guess or default to Candidate #1**, and never fall
back to "the only candidate that currently has files" if more than one candidate exists.

Before reading anything, resolve and verify:
1. `candidate_id` refers to an existing, active row in `candidates` (check via
   `sqlite3 data/app.db "SELECT id, first_name, last_name, status FROM candidates WHERE id = <candidate_id>"`,
   or equivalent). **Stop and tell the user** if it doesn't exist or is archived — do not proceed.
2. `data/candidates/<candidate_id>/master/resume.*` exists. **Stop and tell the user** to upload it
   via `/master-files` for that specific candidate first if it's missing.
3. `data/candidates/<candidate_id>/master/skills.*` exists. Same stop-and-report rule if missing.

**Never read or write another candidate's directory.** There is no implicit "current candidate"
fallback anywhere in this skill — every path is built from the exact `candidate_id` given, and a
mistake in that id must surface as "candidate not found" or "files missing for this candidate," never
as silently substituting a different candidate's data.

## Sources of truth — same precedence as tailor-resume, unconditionally

1. **Master Resume** (`data/candidates/<candidate_id>/master/resume.*`) — employers, titles, dates,
   education, certifications, accomplishments, and which technologies are attributable to which
   employer.
2. **Master Skills Inventory** (`data/candidates/<candidate_id>/master/skills.*`) — technologies the
   candidate genuinely knows. Proves knowledge, never by itself proves employer-level production usage.

**`candidate-profile.json` is a derived, versioned INDEX only — never a second source of truth.**
If anything here ever disagrees with the actual `.docx` files, the `.docx` files win, always. Read
both files in full before writing anything. If either is missing, stop and tell the user to upload
it via `/master-files` for that candidate first — never fabricate a profile from partial input, and
never substitute a different candidate's file just because one happens to be present.

## Evidence discipline — identical to tailor-resume's Attribution Rule

- A skill in the Skills Inventory but not tied to a specific employer in the Master Resume is
  `source: "inventory_only"` — genuine knowledge, but never labeled `"employer"`.
- A skill only counts as `source: "employer"` when a specific Master Resume bullet actually
  attributes it to a specific employer/project — record every employer it's attributed to in
  `attributedTo`.
- **`yearsStated` may only be set when the Master Resume/Skills Inventory states an explicit number
  for that specific skill** (e.g. "5 years of Snowflake experience"). Never compute it from an
  employer's tenure length just because the skill appears somewhere in that role's bullets — that is
  not what the source document said, and inferring it would misrepresent depth of experience the
  candidate never claimed. If in doubt, omit `yearsStated` entirely.
- Never invent: employers, titles, dates, degrees, certifications, or technologies not actually
  documented. Unknown/absent is always preferable to a guess.
- `CandidateExperienceEntry.technologies` lists only the raw skill names that specific role's actual
  bullets attribute — this is the join key the matching engine uses to know which employer backs a
  given skill.

## Skill naming — do not attempt taxonomy normalization yourself

Write `rawSkillName` as it actually appears in the source documents (lightly cleaned — consistent
casing, no trailing punctuation — but not forced into any particular vocabulary). **Do not try to
match skill names to `src/lib/jobIntel/skillsTaxonomy.ts`'s canonical names yourself** — the app
resolves `rawSkillName` against the current taxonomy automatically, every time it matches a job, via
`src/lib/match/normalizeCandidateSkills.ts`. This means a skill the taxonomy doesn't recognize today
is still preserved in full and will start matching automatically the moment someone grows the
taxonomy — you don't need to anticipate that, and guessing a taxonomy name that's slightly wrong
would be worse than just writing the real name.

## Output — `data/candidates/<candidate_id>/candidate-profile.json`

Write exactly this shape (matches `src/lib/match/types.ts`'s `CandidateProfile` /
`src/lib/match/candidateProfile.ts`'s Zod schema — the app will reject anything that doesn't
validate):

```json
{
  "schemaVersion": 1,
  "sourceHashes": { "resume": "<sha256 from data/master/manifest.json's resume entry>", "skills": "<sha256 from manifest.json's skills entry>" },
  "builtAt": "<current ISO timestamp>",
  "skills": [
    { "rawSkillName": "Azure Data Factory", "source": "employer", "attributedTo": [{ "employer": "Comerica Bank" }] },
    { "rawSkillName": "GitHub Actions", "source": "inventory_only" },
    { "rawSkillName": "Snowflake", "source": "employer", "attributedTo": [{ "employer": "Fiserv" }], "yearsStated": 3 }
  ],
  "experience": [
    { "employer": "Comerica Bank", "title": "Data Engineer", "startDate": "2024-02", "endDate": null, "technologies": ["Azure Data Factory", "Azure Databricks"] }
  ],
  "education": [{ "level": "Master's", "field": "Computer Science", "institution": "..." }],
  "certifications": [{ "name": "..." }],
  "totalYearsExperience": null
}
```

**Fetch the exact current `sourceHashes` from `data/candidates/<candidate_id>/master/manifest.json`**
(written by the `/master-files` upload route for that candidate) — do not compute or guess a hash
yourself. `totalYearsExperience` may
be left `null`; the app computes it deterministically from `experience[].startDate/endDate` via
interval-union math (never a naive sum of overlapping roles) — do not attempt this calculation
yourself, and never estimate a total if the dates in the Master Resume are incomplete or ambiguous.

## Failure behavior

Stop and say exactly what's blocking if: `candidate_id` doesn't resolve to an active candidate, the
Master Resume or Skills Inventory is missing **for that candidate**, either file's content is too
sparse to build a defensible profile from, or `manifest.json` doesn't have a `sha256` for a slot
(re-upload the file via `/master-files` first — this build only proceeds against files that were
uploaded through the app, so hashes are always available going forward). Never write a partial or
guessed profile, and never write to any candidate's directory other than the one whose `candidate_id`
was given.

## After writing

Confirm the file validates: run
```bash
npx tsx -e "import { loadCandidateProfile } from './src/lib/match/candidateProfile'; console.log(loadCandidateProfile(<candidate_id>));"
```
(substituting the actual numeric `candidate_id`) and confirm it reports `{ status: "ok", ... }`, not
`"invalid"` or `"stale"`.
