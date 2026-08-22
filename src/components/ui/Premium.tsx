import type { ReactNode } from "react";

/** Lightweight visual primitives. They are CSS-only, add no client boundary, and never carry
 * product state. Feature components opt in when the treatment clarifies an interaction. */
export const PREMIUM_HOVER_LIFT = "premium-hover-lift";
export const PREMIUM_ACTIVE_TAB = "premium-active-tab";
export const PREMIUM_EXPANSION = "premium-expansion";

export function PremiumGradientSurface({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`premium-gradient-surface ${className}`}>{children}</div>;
}

export function StatusAccent({ tone = "accent" }: { tone?: "accent" | "success" | "warning" | "danger" }) {
  return <span aria-hidden="true" className={`premium-status-accent premium-status-${tone}`} />;
}
