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
