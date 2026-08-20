"use client";

/**
 * The aperture — the app's one repeating mark. Category B (decorative atmosphere).
 *
 * Concentric rings closing on a lit point: "something is being brought into focus". It is used in
 * exactly two places, which is the whole discipline of it — a motif stamped on every surface stops
 * being a motif and becomes wallpaper.
 *
 *   figure  the empty state, where there is nothing in focus yet
 *   mark    the command surface, as the workspace's identity glyph
 *
 * It encodes nothing. There is no prop that changes a radius, an opacity, or a count, so it cannot
 * drift into looking like a gauge. Always `aria-hidden`; never interactive.
 */
export function Aperture({ variant = "figure" }: { variant?: "figure" | "mark" }) {
  if (variant === "mark") {
    // At 14px a blur wash renders as a gray smudge and costs a paint layer, so the mark is the
    // line work only — the same geometry, reduced to what actually survives at this size.
    return (
      <span aria-hidden="true" className="relative block h-3.5 w-3.5 shrink-0">
        <span className="absolute inset-0 rounded-full border border-[var(--accent)] opacity-40" />
        <span className="absolute inset-[3px] rounded-full border border-[var(--accent)] opacity-25" />
        <span className="absolute left-1/2 top-1/2 h-[3px] w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--accent)]" />
      </span>
    );
  }

  return (
    <div aria-hidden="true" className="relative h-20 w-20">
      <span className="absolute inset-0 rounded-full border border-[var(--border)] opacity-70" />
      <span className="absolute inset-[9px] rounded-full border border-[var(--border)] opacity-45" />
      <span className="absolute inset-[18px] rounded-full border border-dashed border-[var(--border)] opacity-35" />
      <span className="absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--accent)] shadow-[0_0_16px_var(--accent)]" />
      {/* One soft wash so the mark reads as lit rather than drawn. */}
      <span
        className="absolute inset-0 rounded-full opacity-50 blur-2xl"
        style={{ background: "radial-gradient(circle, var(--accent-soft) 0%, transparent 68%)" }}
      />
    </div>
  );
}
