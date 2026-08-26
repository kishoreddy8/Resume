"use client";

import Link from "next/link";
import { useEffect } from "react";
import { ErrorState } from "@/components/ui/ErrorState";
import { BTN_SECONDARY } from "@/components/ui/Panel";

/**
 * UI-2 — the root route-segment error boundary (design audit: "no error.tsx, so a render throw
 * drops the user to an unstyled default with no landmark structure").
 *
 * Renders INSIDE the root layout — the sidebar and header stay mounted, only the content area
 * this replaces. `global-error.tsx` is the separate, unstyled-by-necessity fallback for the rarer
 * case where the root layout itself fails to render at all.
 *
 * DELIBERATELY GENERIC. This is the catch-all for an error this file cannot know the cause of, so
 * it claims nothing it cannot verify: no "your data is safe" (a render-time throw here could
 * originate anywhere), no assumed cause, no assumed retryability beyond what `reset()` itself
 * actually is — a request to re-render the same segment, which is always a safe thing to attempt
 * once. The real error message and any digest id are logged and available under "Technical
 * details," never shown by default and never a raw stack trace.
 */
export default function RootError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <ErrorState
      title="Something went wrong loading this page"
      whatHappened="An unexpected error interrupted this page. Nothing you were doing caused it, and no action was submitted on your behalf."
      onRetry={reset}
      retryLabel="Try again"
      secondaryAction={
        <Link href="/home" className={BTN_SECONDARY}>
          Back to Home
        </Link>
      }
      technicalDetails={
        <>
          {error.message}
          {error.digest ? `\n\nRef: ${error.digest}` : null}
        </>
      }
    />
  );
}
