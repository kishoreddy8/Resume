"use client";

/**
 * Loading placeholders that hold the layout they are standing in for.
 *
 * The audit found ten bare "Loading…" strings across the app. Each one collapses the page to a
 * single line and then snaps the real content in, which is the layout shift the whole depth system
 * is trying to avoid. These reserve the space instead.
 *
 * The shimmer is suppressed under reduced motion by the `.skeleton` rule in globals.css.
 */
export function SkeletonLine({ className = "" }: { className?: string }) {
  return <div className={`skeleton h-3 rounded-[4px] ${className}`} />;
}

export function SkeletonBlock({ className = "" }: { className?: string }) {
  return <div className={`skeleton rounded-[var(--radius-lg)] ${className}`} />;
}

/** A stand-in for a metric row, matching Metric's own vertical rhythm. */
export function SkeletonMetrics({ count = 4 }: { count?: number }) {
  return (
    <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4" aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i}>
          <SkeletonLine className="w-16" />
          <SkeletonLine className="mt-2 h-6 w-20" />
        </div>
      ))}
    </div>
  );
}

/** A stand-in for a table/list, so rows do not jump in one at a time. */
export function SkeletonRows({ rows = 6, className = "" }: { rows?: number; className?: string }) {
  return (
    <div className={`space-y-2 ${className}`} aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <SkeletonLine key={i} className="h-9 w-full" />
      ))}
    </div>
  );
}

/** The one announcement a screen reader needs while any of the above are on screen. */
export function LoadingRegion({ label = "Loading" }: { label?: string }) {
  return (
    <span role="status" aria-live="polite" className="sr-only">
      {label}
    </span>
  );
}
