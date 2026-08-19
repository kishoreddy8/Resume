# CareerOps — running it locally (Stage 28)

Two processes, both on this Mac. Nothing here needs Docker, a VM, or any cloud service.

## Why two processes

Everything used to run inside the Next.js server. Stage 27 measured what that cost: a production
ingestion pass drove the web process to 99.6% CPU and `/api/health` returned nothing at all for
roughly thirty minutes, because Node is single-threaded and a multi-second SQLite scan or a CPU-bound
render blocks every in-flight HTTP request in the same process.

Stage 28 moves the scheduled work into its own process. The tick functions are unchanged — only
*where* they run changed.

## Start it

**Terminal 1 — web (UI + API, runs no scheduled work):**

```
CAREER_OPS_SCHEDULER_HOST=worker npm run dev
```

**Terminal 2 — background worker (owns all scheduled work):**

```
CAREER_OPS_SCHEDULER_HOST=worker npm run background-worker
```

Both read the same `CAREER_OPS_SCHEDULER_HOST` value, which is what makes it impossible for both to
arm the scheduler.

| `CAREER_OPS_SCHEDULER_HOST` | Who runs the ticks |
|---|---|
| unset or `web` | The Next.js process — the pre-Stage-28 default, so an existing setup is unchanged. `npm run dev` alone still works, but long ingestion passes will block the UI. |
| `worker` | Only `npm run background-worker`. The web process starts no timers. **This is the recommended local setup.** |
| `none` | Nobody. Useful for one-off CLI work. |

The worker refuses to start unless the value is `worker`, and refuses to start a second copy while one
is already running (pid lockfile with stale recovery). The database leases — scan lock,
production-cycle lease, machine-wide writer lease — remain authoritative regardless, so even a
misconfiguration cannot run two writer passes at once.

## What each process does

**Web process** — UI, API routes, status. No scan, no ingestion, no evaluation, no resume writing.

**Background worker** — the four scheduled ticks, on the same 60-second check interval and the same
per-tick cadences as before:

- scan / discovery
- production ingestion cycle
- deterministic job evaluation
- resume writer

It runs them **sequentially**, so a long production cycle delays the writer tick within the worker.
That is a known limitation, not a fault.

## Automation settings

The scheduler settings are unchanged and still govern everything:

- `scheduler.enabled` — master kill switch. Nothing runs when it is off.
- `scheduler.scanEnabled` / `productionEnabled` / `evaluationEnabled` / `writerEnabled` — per-tick
  switches. A tick runs only when the master switch **and** its own switch are on.
- Window and timezone apply as before.

**`writerEnabled` is currently `false` and is not turned on automatically.** The resume writer is the
one tick that spends your Claude subscription, so enabling it is a deliberate operator decision. With
it off, discovery and evaluation still run and cost nothing.

## Writer behaviour

- **Concurrency: 1.** Enforced by the machine-wide writer lease, not by a queue setting. Never
  increase it without measuring first.
- **Maximum 2 Claude content attempts** per workflow. There is no third generation.
- Technical failures — provider outage, exhausted subscription, logged-out CLI — consume **zero**
  content attempts.
- Claude runs through your authenticated CLI subscription. No API key is used or required.

## Outcomes you will see

- **READY** — every quality gate passed. Published by Phase 9A, unchanged.
- **SAFE BEST ATTEMPT — HUMAN REVIEW REQUIRED** — every absolute truthfulness/safety check passed but
  the full optimisation bar was not met. The documents are usable; you decide. Published to a
  `human-review/` subdirectory beside where the READY artifacts for that job would go, and never
  labelled READY or approved.
- **BLOCKED / DO NOT APPLY** — a real truthfulness or safety blocker remains. No application
  downloads are offered.

CareerOps never submits an application, and tailoring never starts without your explicit approval.

## Typical timings (measured, real corpus)

| | |
|---|---|
| One Claude content generation | ~4–5 minutes |
| All CareerOps work around it (import, full Stage 21 review, both DOCX renders, publication) | **~1.4 seconds** |
| Single-attempt workflow | ~4m48s |
| Two-attempt workflow | ~8m52s |

Claude generation is ~99.7% of the wall clock. If tailoring feels slow, that is where the time is.
