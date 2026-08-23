export const ADMIN_STATUSES = [
  "healthy",
  "degraded",
  "offline",
  "disabled",
  "unknown",
  "idle",
  "queued",
  "running",
  "waiting",
  "needs_intervention",
  "failed",
  "completed",
  "version_mismatch",
  "stale",
] as const;

export type AdminStatusKey = (typeof ADMIN_STATUSES)[number];

export const ADMIN_STATUS_PRESENTATION: Record<
  AdminStatusKey,
  { label: string; tone: "positive" | "warning" | "critical" | "neutral" | "info"; symbol: string }
> = {
  healthy: { label: "Healthy", tone: "positive", symbol: "✓" },
  degraded: { label: "Degraded", tone: "warning", symbol: "!" },
  offline: { label: "Offline", tone: "critical", symbol: "×" },
  disabled: { label: "Disabled", tone: "neutral", symbol: "–" },
  unknown: { label: "Unknown", tone: "neutral", symbol: "?" },
  idle: { label: "Idle", tone: "neutral", symbol: "○" },
  queued: { label: "Queued", tone: "info", symbol: "↗" },
  running: { label: "Running", tone: "info", symbol: "●" },
  waiting: { label: "Waiting", tone: "warning", symbol: "…" },
  needs_intervention: { label: "Needs intervention", tone: "warning", symbol: "!" },
  failed: { label: "Failed", tone: "critical", symbol: "×" },
  completed: { label: "Completed", tone: "positive", symbol: "✓" },
  version_mismatch: { label: "Version mismatch", tone: "critical", symbol: "!" },
  stale: { label: "Stale", tone: "warning", symbol: "◷" },
};

export function normalizeAdminStatus(value: string | null | undefined): AdminStatusKey {
  if (!value) return "unknown";
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if ((ADMIN_STATUSES as readonly string[]).includes(normalized)) {
    return normalized as AdminStatusKey;
  }
  const aliases: Record<string, AdminStatusKey> = {
    ready: "healthy",
    active: "healthy",
    success: "completed",
    passed: "completed",
    stopped: "disabled",
    paused: "disabled",
    off: "disabled",
    warning: "degraded",
    recovering: "degraded",
    partial: "degraded",
    error: "failed",
    down: "offline",
    unauthorized: "needs_intervention",
    needs_configuration: "needs_intervention",
    blocked: "needs_intervention",
    processing: "running",
    started: "running",
    mismatch: "version_mismatch",
    uninitialized: "idle",
  };
  return aliases[normalized] ?? "unknown";
}
