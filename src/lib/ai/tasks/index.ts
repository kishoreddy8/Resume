/**
 * The explicit, human-auditable task manifest — the single place every AI task is registered.
 * Adding a task means adding one line here, never an incidental side-effect import buried in a
 * route or feature file. src/lib/ai/runAiTask.ts imports this module once, at its own top level,
 * so every task is guaranteed registered before ANY call to runAiTask can execute — regardless of
 * which route/feature happens to run first, with zero registration discipline required from future
 * feature authors.
 */
import { registerTask } from "./registry";
import { jobDetailEnrichmentTask } from "./jobDetailEnrichment";

registerTask(jobDetailEnrichmentTask);
