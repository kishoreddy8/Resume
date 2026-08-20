"use client";

import type { ReactNode } from "react";

/**
 * The depth planes, as one component instead of a class string every page re-invents.
 *
 * The Jobs workspace already proved this system; the rest of the app was still writing raw
 * `bg-white dark:bg-zinc-900 border border-zinc-200` by hand — 687 raw-palette references across
 * the other routes, versus 7 in Jobs. That is the single largest inconsistency in the application,
 * and it is why the other pages read as a different product.
 *
 *   z0  application canvas   — the ground; nothing "is" a z0 surface, it is what shows through
 *   z1  navigation           — the rail and the toolbar
 *   z2  workspace            — the working container a page lives in
 *   z3  intelligence         — a surface the user reads and reasons about
 *   z4  floating             — docks and bars that hover over content
 *   z5  menus/dialogs        — opaque, above everything
 *
 * `lift` and the lit top edge come from the plane classes, so elevation is never hand-rolled.
 */
export type SurfaceLevel = "z1" | "z2" | "z3" | "z4" | "z5";

const PLANE: Record<SurfaceLevel, string> = {
  z1: "bg-[var(--z1-bg)]",
  z2: "plane plane-2",
  z3: "plane plane-3",
  z4: "plane plane-4",
  z5: "plane plane-5",
};

export function Surface({
  level = "z3",
  className = "",
  children,
  as: Tag = "div",
  ...rest
}: {
  level?: SurfaceLevel;
  className?: string;
  children?: ReactNode;
  as?: "div" | "section" | "aside" | "article";
} & React.HTMLAttributes<HTMLElement>) {
  return (
    <Tag className={`relative ${PLANE[level]} ${className}`} {...rest}>
      {children}
    </Tag>
  );
}
