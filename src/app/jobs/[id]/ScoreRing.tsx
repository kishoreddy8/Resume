"use client";

import { motion, useReducedMotion } from "motion/react";

/**
 * The match score as a luminous arc.
 *
 * Every pixel of it is the engine's own number. The sweep is `score/100` of a
 * circle and nothing else — there is no easing of the value, no animated
 * count-up past the real figure, no second decorative ring implying a metric
 * that does not exist.
 *
 * The untrusted case is the reason this component has a `trusted` prop rather
 * than just a number. When the engine flags insufficient JD signal the score is
 * an unknown, not a low score, so drawing a small arc would be a lie told in
 * graphics — the ring renders as a dashed, unfilled track with an em dash, and
 * the caller still prints the caveat in words beside it.
 */
export function ScoreRing({
  score,
  trusted,
  tone,
  size = 108,
}: {
  score: number | null;
  /** False when insufficientJdSignal is set — the number exists but means nothing. */
  trusted: boolean;
  tone: "ready" | "review" | "blocked" | "neutral";
  size?: number;
}) {
  const reduced = useReducedMotion() ?? false;
  const stroke = 7;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = trusted && score !== null ? Math.max(0, Math.min(100, score)) / 100 : 0;

  const strokeColor =
    tone === "ready"
      ? "var(--success)"
      : tone === "review"
        ? "var(--warning)"
        : tone === "blocked"
          ? "var(--error)"
          : "var(--text-tertiary)";

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      {/* Illumination sits behind the arc, tinted by the same semantic colour, so
       *  the verdict reads as lit rather than merely coloured. */}
      {trusted && (
        <div
          aria-hidden="true"
          className="absolute inset-0 rounded-full opacity-45 blur-xl"
          style={{ background: `radial-gradient(circle, ${strokeColor} 0%, transparent 66%)` }}
        />
      )}

      <svg width={size} height={size} className="relative -rotate-90" aria-hidden="true">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--separator)"
          strokeWidth={stroke}
          strokeDasharray={trusted ? undefined : "3 5"}
        />
        {trusted && (
          <motion.circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={strokeColor}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={c}
            initial={reduced ? false : { strokeDashoffset: c }}
            animate={{ strokeDashoffset: c * (1 - pct) }}
            /* Was 0.7s, which finished ~250ms after everything else had settled — the number
             *  arriving last is intentional, arriving alone is not. 0.46s still lets the sweep
             *  read as a sweep while landing just inside the choreography's tail. */
            transition={reduced ? { duration: 0 } : { type: "spring", duration: 0.46, bounce: 0 }}
          />
        )}
      </svg>

      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span
          className="text-[30px] font-semibold leading-none tabular-nums tracking-[-0.02em]"
          style={{ color: trusted ? "var(--text-primary)" : "var(--text-tertiary)" }}
        >
          {trusted && score !== null ? Math.round(score) : "—"}
        </span>
        <span className="mt-1 text-[9px] font-medium uppercase tracking-[0.12em] text-tertiary">
          {trusted ? "Match" : "Unknown"}
        </span>
      </div>
    </div>
  );
}
