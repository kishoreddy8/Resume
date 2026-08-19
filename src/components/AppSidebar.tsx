"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { CandidateSelector } from "@/components/CandidateSelector";

/**
 * CareerOps UI Stage 1 — the application shell's primary navigation.
 *
 * The nine existing routes, grouped by what the user is doing rather than
 * listed flat: the work itself, the data behind it, and the machinery that
 * keeps it running. Every entry points at a route that already exists; no
 * placeholder destinations were added to round out a group.
 *
 * Text-only by design. The project has no icon set, and inventing one or
 * installing a library for it would cost more than the labels are worth —
 * labels also name their contents directly, which is what makes a destination
 * predictable before you click it.
 *
 * One component serves both layouts. Below `lg` the same tree reflows into a
 * stacked strip along the top (the group headings drop out and the items become
 * one scrollable row); at `lg` and above it is the persistent left column. It is
 * built this way rather than as two components so that CandidateSelector mounts
 * exactly once — a second copy hidden by CSS would still run its own fetches and
 * hold its own state, which is a behaviour change, not a layout one.
 */

interface NavItem {
  href: string;
  label: string;
  /** Sub-routes that should keep this item selected (e.g. a job detail page). */
  matchPrefix?: RegExp;
}

interface NavGroup {
  title: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    title: "Work",
    items: [
      { href: "/jobs", label: "Jobs", matchPrefix: /^\/jobs\/\d+$/ },
      { href: "/pipeline", label: "Pipeline" },
      { href: "/jobs/archived", label: "Archived" },
    ],
  },
  {
    title: "Data",
    items: [
      { href: "/companies", label: "Companies" },
      { href: "/ats-coverage", label: "ATS Coverage" },
      { href: "/master-files", label: "Master Files" },
    ],
  },
  {
    title: "System",
    items: [
      { href: "/scanner", label: "Scanner" },
      { href: "/operations", label: "Operations" },
      { href: "/settings", label: "Settings" },
    ],
  },
];

/**
 * Exact match, plus an optional pattern for detail routes. Deliberately not a
 * `startsWith` test: `/jobs/archived` starts with `/jobs`, and highlighting two
 * destinations at once would make the selection meaningless.
 */
export function isNavItemActive(item: NavItem, pathname: string): boolean {
  if (pathname === item.href) return true;
  return item.matchPrefix ? item.matchPrefix.test(pathname) : false;
}

/** True only where the rail is a left column. Below this the rail is a full-width top strip and
 *  must not receive an animated pixel width, so collapsing is a desktop-only affordance. */
function useDesktopRail() {
  const [desktop, setDesktop] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const apply = () => setDesktop(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  return desktop;
}

export function AppSidebar() {
  const pathname = usePathname();
  const reduced = useReducedMotion() ?? false;
  // Collapsing the rail hands its width to the workspace. Collapsed keeps a visible strip with the
  // re-open control, so navigation is never hidden behind a gesture or a guess.
  const [open, setOpen] = useState(true);
  const desktop = useDesktopRail();
  const collapsed = desktop && !open;

  return (
    <motion.aside
      initial={false}
      animate={desktop ? { width: open ? 216 : 48 } : {}}
      transition={reduced ? { duration: 0 } : { type: "spring", duration: 0.28, bounce: 0 }}
      className="flex w-full shrink-0 flex-col overflow-hidden border-b border-[var(--separator)] bg-surface-sidebar lg:h-full lg:border-b-0 lg:border-r"
    >
      <div className="flex h-12 shrink-0 items-center gap-1 px-4 lg:h-14 lg:px-3">
        {!collapsed && (
          <Link href="/jobs" className="truncate px-2 text-[13px] font-semibold tracking-tight text-primary">
            career-ops
          </Link>
        )}
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={open ? "Collapse navigation" : "Expand navigation"}
          title={open ? "Collapse navigation" : "Expand navigation"}
          className="ml-auto hidden shrink-0 rounded-md px-1.5 py-1 text-[11px] text-tertiary transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] hover:text-primary active:scale-[0.98] lg:block"
        >
          <span aria-hidden="true">{open ? "\u25C0" : "\u25B6"}</span>
        </button>
      </div>

      <nav
        hidden={collapsed}
        aria-label="Primary"
        className="flex gap-1 overflow-x-auto px-3 pb-2 lg:flex-1 lg:flex-col lg:gap-0 lg:overflow-x-visible lg:overflow-y-auto lg:pb-4"
      >
        {NAV_GROUPS.map((group) => (
          // `contents` lets the items join the horizontal row directly on narrow
          // screens while staying a titled block in the sidebar.
          <div key={group.title} className="contents lg:mb-5 lg:block lg:last:mb-0">
            <h2 className="mb-1 hidden px-2.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-tertiary lg:block">
              {group.title}
            </h2>
            <div className="contents lg:flex lg:flex-col lg:gap-px">
              {group.items.map((item) => {
                const active = isNavItemActive(item, pathname);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={`shrink-0 rounded-md px-2.5 py-1.5 text-[13px] leading-5 transition-colors duration-150 ease-out lg:block ${
                      active
                        ? "bg-[var(--surface-selected)] font-medium text-primary"
                        : "font-normal text-secondary hover:bg-[var(--surface-hover)] hover:text-primary active:bg-[var(--surface-active)]"
                    }`}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* Account area — the active candidate is persistent context, not a page
       *  action, so it sits at the foot of the shell rather than in the toolbar. */}
      <div hidden={collapsed} className="shrink-0 border-t border-[var(--separator)] px-3 py-2.5 lg:py-3">
        <h2 className="mb-1.5 hidden px-2.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-tertiary lg:block">
          Candidate
        </h2>
        <CandidateSelector />
      </div>
    </motion.aside>
  );
}
