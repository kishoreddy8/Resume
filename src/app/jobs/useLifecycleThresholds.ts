"use client";

import { useEffect, useState } from "react";
import { ACTIVE_MAX_DAYS, ARCHIVE_MAX_DAYS, FRESH_MAX_DAYS, type LifecycleThresholds } from "@/lib/jobLifecycle";

const FALLBACK_THRESHOLDS: LifecycleThresholds = {
  freshMaxDays: FRESH_MAX_DAYS,
  activeMaxDays: ACTIVE_MAX_DAYS,
  archiveMaxDays: ARCHIVE_MAX_DAYS,
};

/**
 * Fetches Settings > Lifecycle (the same /api/settings the Settings page reads/writes — no second
 * configuration path) and maps it onto the LifecycleThresholds shape the actual lifecycle engine
 * (src/db/queries/jobs.ts's runAgeBasedSweep) uses, so a job's Fresh/Active/Aging/Stale badge can
 * never disagree with what the automated sweep will actually do to it.
 *
 * `loaded` starts false so callers can hold off rendering age-derived UI until the real, configured
 * thresholds are in, rather than briefly flashing the hardcoded fallback and then jumping to a
 * different (correct) band a moment later.
 */
export function useLifecycleThresholds(): { thresholds: LifecycleThresholds; loaded: boolean } {
  const [thresholds, setThresholds] = useState<LifecycleThresholds>(FALLBACK_THRESHOLDS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data: { settings?: { lifecycle?: { freshDays: number; archiveAfterDays: number; deleteAfterDays: number } } }) => {
        if (cancelled) return;
        const lifecycle = data.settings?.lifecycle;
        if (lifecycle) {
          setThresholds({
            freshMaxDays: lifecycle.freshDays,
            activeMaxDays: lifecycle.archiveAfterDays,
            archiveMaxDays: lifecycle.deleteAfterDays,
          });
        }
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { thresholds, loaded };
}
