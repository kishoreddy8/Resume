import { SkeletonLine, SkeletonBlock, LoadingRegion } from "@/components/ui/Skeleton";

/**
 * UI-2 — the one route-level loading boundary, at the app root so it covers every route transition
 * that doesn't already have its own more specific one. Reserves roughly the shape every candidate
 * route already renders — a page title, then content blocks — using the SAME skeleton primitives
 * (and the same reduced-motion-aware shimmer) already used elsewhere, not a second loading system.
 *
 * No percentage, no spinner: this is generic route-transition cover, not a real workflow with real
 * named stages (the resume/application progress systems own that, unchanged by this file).
 */
export default function Loading() {
  return (
    <div>
      {/* Announced to assistive tech; must live OUTSIDE the hidden decorative block below it,
       *  since aria-hidden on an ancestor would otherwise silence this live region too. */}
      <LoadingRegion label="Loading page" />
      <div aria-hidden="true">
        <SkeletonLine className="h-7 w-52" />
        <SkeletonLine className="mt-2.5 h-3.5 w-80" />
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <SkeletonBlock className="h-32" />
          <SkeletonBlock className="h-32" />
          <SkeletonBlock className="h-32" />
        </div>
        <SkeletonBlock className="mt-6 h-64" />
      </div>
    </div>
  );
}
