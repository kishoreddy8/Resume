"use client";

import { useEffect, useState } from "react";
import { useActiveCandidateId } from "@/lib/useActiveCandidateId";

/**
 * Why a job list is empty, when the reason is setup rather than filters.
 *
 * An empty list has two completely different meanings and used to render identically. "No jobs
 * match these filters" is true only once the queue has actually been evaluated; said to someone
 * whose profile is still being built, it is simply wrong — and it is the wording that made testers
 * conclude the app was broken. Nothing had failed; nothing had run yet.
 *
 * Returns null whenever setup is complete, so a finished account keeps its ordinary filter-based
 * empty states untouched.
 */
export interface SetupNotice {
  title: string;
  body: string;
  /** Where the user should go to move setup forward. */
  href: string;
  cta: string;
}

interface SetupResponse {
  steps: { resume: boolean; skills: boolean; preferences: boolean; profile: boolean; evaluated: boolean };
  complete: boolean;
}

export function useSetupNotice(): SetupNotice | null {
  const candidateId = useActiveCandidateId();
  const [notice, setNotice] = useState<SetupNotice | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function check() {
      try {
        const [setupRes, buildRes] = await Promise.all([
          fetch(`/api/candidates/${candidateId}/setup`),
          fetch(`/api/candidates/${candidateId}/build-profile`),
        ]);
        /* A locked profile stops the poll dead. Every 401 dispatches the app-wide profile-locked
         * event, so retrying would throw a PIN prompt at the user on a timer — and a list we
         * cannot explain is better left with its ordinary empty state than with a guess. */
        if (setupRes.status === 401 || buildRes.status === 401) {
          if (!cancelled) setNotice(null);
          stopped = true;
          clearInterval(id);
          return;
        }
        if (cancelled || !setupRes.ok) return;
        const setup = (await setupRes.json()) as SetupResponse;
        const build = buildRes.ok ? await buildRes.json() : { status: "idle" };
        if (cancelled) return;

        // A finished account gets no notice at all — its empty states are about filters again.
        if (setup.complete) {
          setNotice(null);
          return;
        }

        if (build.status === "running") {
          setNotice({
            title: "Your profile is still being built",
            body:
              `${build.phase ?? "Reading your documents"} right now. Jobs are matched against your profile, ` +
              "so there is nothing to show until this finishes — usually about two minutes.",
            href: "/onboarding",
            cta: "Watch setup",
          });
          return;
        }

        if (!setup.steps.resume || !setup.steps.skills) {
          setNotice({
            title: "Upload your documents to see matches",
            body:
              "Matching reads your Master Resume and Master Skills Inventory. Until both are uploaded there is " +
              "nothing to match jobs against — this list is empty for that reason, not because no jobs exist.",
            href: "/onboarding",
            cta: "Upload documents",
          });
          return;
        }

        if (!setup.steps.preferences) {
          setNotice({
            title: "Set your target role to see matches",
            body: "Your target role decides how this list is ordered. Set it and evaluation runs on its own.",
            href: "/onboarding",
            cta: "Set target role",
          });
          return;
        }

        if (!setup.steps.profile) {
          setNotice({
            title: "Your profile has not been built yet",
            body:
              "Your documents are uploaded, but the profile the matching engine reads has not been built from " +
              "them yet. Nothing is evaluated until it exists.",
            href: "/onboarding",
            cta: "Finish setup",
          });
          return;
        }

        if (!setup.steps.evaluated) {
          setNotice({
            title: "No jobs have been evaluated yet",
            body:
              "Your profile is ready and evaluation has not finished running. Matches appear here as jobs are scored.",
            href: "/onboarding",
            cta: "Open setup",
          });
          return;
        }

        setNotice(null);
      } catch {
        // Never invent a reason. With no answer, the caller keeps its ordinary empty state.
      }
    }

    let stopped = false;
    /* Slow on purpose: the states it reports change on the order of minutes. */
    const id = setInterval(() => {
      if (!stopped) check();
    }, 8000);
    check();
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [candidateId]);

  return notice;
}
