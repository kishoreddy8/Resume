import type { StepKey, WorkflowStep } from "./workflowSteps";

export const WORKSPACE_STEP_KEYS: readonly StepKey[] = [
  "match",
  "studio",
  "results",
  "validation",
  "application",
];

export const WORKSPACE_FOCUS_KEYS = [
  "tailor",
  "retailor",
  "progress",
  "revalidate",
  "issues",
] as const;

export type WorkspaceFocus = (typeof WORKSPACE_FOCUS_KEYS)[number];

export interface WorkspaceRouteRequest {
  step: StepKey | null;
  focus: WorkspaceFocus | null;
}

type SearchValue = string | string[] | undefined;

function first(value: SearchValue): string | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

export function isWorkspaceStep(value: string | null): value is StepKey {
  return value !== null && (WORKSPACE_STEP_KEYS as readonly string[]).includes(value);
}

export function isWorkspaceFocus(value: string | null): value is WorkspaceFocus {
  return value !== null && (WORKSPACE_FOCUS_KEYS as readonly string[]).includes(value);
}

/** Reads only a small allowlist. Unknown values are ignored, never reflected into the DOM or used
 * as commands. This function has no access to fetch, workflow mutations, or browser state. */
export function parseWorkspaceRoute(
  searchParams: Record<string, SearchValue> | null | undefined
): WorkspaceRouteRequest {
  const step = first(searchParams?.step);
  const focus = first(searchParams?.focus);
  return {
    step: isWorkspaceStep(step) ? step : null,
    focus: isWorkspaceFocus(focus) ? focus : null,
  };
}

export function jobWorkspaceUrl(
  jobId: number,
  request: Partial<WorkspaceRouteRequest> = {}
): string {
  const params = new URLSearchParams();
  if (request.step) params.set("step", request.step);
  if (request.focus) params.set("focus", request.focus);
  const query = params.toString();
  return `/jobs/${jobId}${query ? `?${query}` : ""}`;
}

/** A deep link may show a step only when the current presentation model says it is reachable and
 * carries no unresolved eligibility reason. In particular, `?step=application` cannot make an
 * uncleared application step eligible. This changes presentation only; server guards remain the
 * authority for every action. */
function canSelectFromRoute(step: WorkflowStep | undefined): step is WorkflowStep {
  return Boolean(
    step &&
      step.state !== "locked" &&
      step.state !== "blocked" &&
      step.lockedReason === null
  );
}

export function resolveWorkspaceRouteStep(
  requested: StepKey | null,
  steps: WorkflowStep[],
  fallback: StepKey
): StepKey {
  const byKey = new Map(steps.map((step) => [step.key, step]));
  if (requested && canSelectFromRoute(byKey.get(requested))) return requested;

  const anchor = requested ?? fallback;
  const anchorIndex = WORKSPACE_STEP_KEYS.indexOf(anchor);
  const candidates = WORKSPACE_STEP_KEYS
    .map((key, index) => ({ key, index, step: byKey.get(key) }))
    .filter((candidate) => canSelectFromRoute(candidate.step))
    .sort((a, b) => {
      const distance = Math.abs(a.index - anchorIndex) - Math.abs(b.index - anchorIndex);
      return distance || a.index - b.index;
    });

  return candidates[0]?.key ?? fallback;
}
