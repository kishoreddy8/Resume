"use client";

/**
 * What the app can honestly say about the local Claude CLI.
 *
 * The rules this component exists to enforce:
 *
 *   - "Installed" means `claude --version` ran and returned a version. That is all it means.
 *   - It never says "connected". Nothing here verifies an authenticated session, and a version
 *     string is not proof of one — asserting it would be inventing a fact on a screen whose entire
 *     purpose is to be trustworthy.
 *   - It never mentions an API key, because none is used. Profile building runs through the user's
 *     own locally authenticated Claude CLI subscription.
 *   - While a build is running it reports the CLI's real current step, taken from the same observed
 *     phases the rail uses — never a generic "thinking" state.
 */

export type CliState = "installed" | "disabled" | "unavailable" | "unknown";

export function ClaudeStatus({
  state,
  version,
  activity,
}: {
  state: CliState;
  version?: string;
  /** The CLI's actual current step while a build runs. Omitted when nothing is running. */
  activity?: string | null;
}) {
  if (state === "unknown") return null;

  const tone =
    state === "installed"
      ? "border-[var(--border)]"
      : "border-[var(--warning)]/40 bg-[color-mix(in_oklab,var(--warning)_7%,transparent)]";

  let line: string;
  if (activity) line = activity;
  else if (state === "installed") line = "Installed and ready to run.";
  else if (state === "disabled") line = "Switched off in this environment.";
  else line = "Not found on this machine.";

  return (
    <div className={`flex items-start gap-2.5 rounded-[var(--radius-lg)] border px-3 py-2 ${tone}`}>
      <span
        aria-hidden="true"
        className={`mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full ${
          activity
            ? "bg-[var(--accent)]"
            : state === "installed"
              ? "bg-[var(--success)]"
              : "border border-[var(--warning)] bg-transparent"
        }`}
      />
      <div className="min-w-0">
        <div className="text-[11.5px] font-medium text-secondary">
          Local Claude CLI
          {version && state === "installed" && (
            <span className="ml-1.5 font-normal text-tertiary">{version}</span>
          )}
        </div>
        <p className="text-[11px] leading-relaxed text-tertiary">{line}</p>
        {state === "installed" && !activity && (
          <p className="mt-0.5 text-[10.5px] leading-relaxed text-tertiary">
            Builds run on your own Claude subscription. No API key is used.
          </p>
        )}
      </div>
    </div>
  );
}
