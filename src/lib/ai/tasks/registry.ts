import type { AiTaskDefinition } from "../types";

/**
 * The single lookup table every task id is registered in. Empty in this infrastructure-only phase —
 * no feature (job-intel enrichment, H1B alias suggestion, etc.) is implemented yet. A future task
 * module (e.g. src/lib/ai/tasks/jobIntelEnrichment.ts) would call registerTask() once, at import
 * time; runAiTask.ts looks tasks up here by id and fails loudly on an unknown id rather than
 * silently doing nothing.
 */
const registry = new Map<string, AiTaskDefinition<unknown, unknown>>();

export function registerTask<TInput, TOutput>(task: AiTaskDefinition<TInput, TOutput>): void {
  registry.set(task.id, task as unknown as AiTaskDefinition<unknown, unknown>);
}

export function getTask(taskId: string): AiTaskDefinition<unknown, unknown> | undefined {
  return registry.get(taskId);
}

/** Test-only: clears every registered task so tests don't leak a fake task definition across files.
 *  Real app code never calls this. */
export function clearTasksForTests(): void {
  registry.clear();
}
