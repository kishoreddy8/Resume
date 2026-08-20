import fs from "node:fs";

/**
 * Snapshot-and-restore for candidate-profile.json.
 *
 * WHY IT IS SEPARATE. This is the safety net under the entire build, and it used to live inline in
 * a route handler where nothing could test it. The guarantee it makes — a failed build never
 * leaves a candidate worse off than before it ran — is the one claim on the setup screen that
 * would be most damaging to get wrong, so it is now a unit with tests of its own.
 *
 * THE MODEL IS NEVER AUTHORITATIVE. The CLI writes candidate-profile.json directly, so by the time
 * validation runs, whatever it produced has already replaced what was there. Restoring is the only
 * way "rejected" can actually mean rejected rather than "rejected, but kept anyway".
 */

/** Read the current profile, or null when there is none. Call BEFORE the build writes anything. */
export function snapshotProfile(profilePath: string): Buffer | null {
  return fs.existsSync(profilePath) ? fs.readFileSync(profilePath) : null;
}

/**
 * Put things back exactly as they were.
 *
 * A null snapshot means there was no profile before, so the correct restoration is REMOVING the
 * rejected file — not leaving it in place. Leaving it would hand the matching engine a profile
 * that failed its own validation, which is precisely the outcome validation exists to prevent.
 */
export function restoreProfile(profilePath: string, previous: Buffer | null): void {
  if (previous) {
    fs.writeFileSync(profilePath, previous);
    return;
  }
  if (fs.existsSync(profilePath)) fs.rmSync(profilePath, { force: true });
}
