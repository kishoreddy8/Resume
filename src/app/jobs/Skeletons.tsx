"use client";

/**
 * Loading placeholders for the Workbench.
 *
 * The rule these follow is that a loading state should reserve the space its content will occupy,
 * so resolving does not shove the page around — a bare "Loading…" line collapsed the whole
 * workspace and then snapped it back, which is the single least premium moment in the app.
 *
 * Deliberately cheap: a handful of tinted blocks, one CSS animation, no blur and no per-row
 * component. Reduced motion stops the sweep via the global rule and leaves a static tint.
 */

function Line({ w, h = 10 }: { w: string; h?: number }) {
  return <div className="skeleton" style={{ width: w, height: h }} />;
}

/** Mirrors JobRow's two-line, 59px geometry so the list does not resize when real rows arrive. */
export function JobListSkeleton({ rows = 12 }: { rows?: number }) {
  return (
    <div aria-hidden="true" className="min-h-0 flex-1 overflow-hidden">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="border-b border-[var(--separator)] px-4 py-2">
          <div className="flex items-center gap-3">
            <Line w={`${52 - ((i * 7) % 22)}%`} h={12} />
            <div className="ml-auto flex items-center gap-2">
              <Line w="22px" />
              <Line w="88px" h={16} />
            </div>
          </div>
          <div className="mt-2 flex items-center gap-3">
            <Line w={`${34 - ((i * 5) % 14)}%`} />
            <Line w="62px" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Mirrors the detail pane's opening rhythm: identity, verdict row, reason block, action dock. */
export function JobReviewSkeleton() {
  return (
    <div aria-hidden="true" className="bg-surface">
      <div className="space-y-3 px-5 py-4">
        <Line w="62%" h={22} />
        <Line w="40%" />
        <Line w="30%" />
      </div>
      <div className="space-y-3 border-t border-[var(--separator)] px-5 py-4">
        <div className="flex items-center gap-3">
          <Line w="132px" h={26} />
          <Line w="78px" h={14} />
          <Line w="96px" h={14} />
        </div>
        <Line w="90%" />
        <Line w="72%" />
        <div className="pt-2">
          <Line w="164px" h={34} />
        </div>
      </div>
      <div className="space-y-3 border-t border-[var(--separator)] px-5 py-4">
        <Line w="34%" h={14} />
        <Line w="88%" />
        <Line w="80%" />
      </div>
    </div>
  );
}

/** Announces the wait to assistive technology while the visual skeleton stays decorative. */
export function LoadingRegion({ label }: { label: string }) {
  return (
    <span role="status" aria-live="polite" className="sr-only">
      {label}
    </span>
  );
}
