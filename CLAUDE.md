@AGENTS.md

## Active development branch

When the current branch is `codex/ats-job-discovery-50k`, read
`ATS_MULTI_AGENT_HANDOFF.md`, `CLAUDE_ATS_CONTINUATION_RUNBOOK.md`, and
`CAREER_OPS_ATS_DISCOVERY_50K_CHECKPOINT.md` before making changes. The multi-agent handoff and
runbook are the fresh-session operational entry points; the checkpoint is the
authoritative,
living checkpoint for the ATS/company-discovery scale-up. This branch does **not** implement Phase 3
resume tailoring; do not start or expand tailoring work unless the user explicitly changes scope.

For company lists, provenance, domain/ATS state, and safe job-loading commands, also read
`ATS_DISCOVERY_SOURCE_OF_TRUTH.md`. If the user asks Claude to continue discovery and load jobs,
follow `CLAUDE_ATS_JOB_LOADING_PROMPT.md` exactly.

## Context policy: Headroom MCP

Headroom MCP (`headroom_compress` / `headroom_retrieve` / `headroom_stats`) is available for
context reduction during long sessions. Use it **selectively**; never start the Headroom proxy.

**Compress before carrying forward** (large, low-risk bulk): terminal/test output, build and lint
logs, repetitive search results, large JSON diagnostic packages, generated reports, benchmark
output, other verbose tool output, and large file contents where only structure/findings matter.

**Never compress** (exactness required): code being edited; implementation requirements;
architecture decisions; user instructions; acceptance criteria; failing-test detail under active
debugging; git diffs under review; schemas/interfaces/contracts; Career-Ops truthfulness and safety
policies; MSI evidence rules; deterministic ecosystem rules; immutable candidate facts; and prompts
about to be sent to the external resume writer.

Call `headroom_retrieve` with the stored hash whenever compressed content is needed for an exact
implementation decision. Compression is a context optimization only — it must never change what
gets implemented, tested, or written into a resume artifact.
