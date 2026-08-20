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
      { href: "/dashboard", label: "Dashboard" },
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
      { href: "/candidate-intelligence", label: "Candidate" },
      { href: "/master-files", label: "Master Files" },
    ],
  },
  {
    title: "System",
    items: [
      { href: "/scanner", label: "ATS Operations" },
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
      className="flex w-full shrink-0 flex-col overflow-hidden border-b border-[var(--separator)] bg-[var(--z1-bg)] lg:h-full lg:border-b-0 lg:border-r"
    >
      <div className="flex h-12 shrink-0 items-center gap-1 px-4 lg:h-14 lg:px-3">
        {!collapsed && (
          <Link
            href="/jobs"
            className="group flex min-w-0 items-center gap-2 rounded-md px-2 transition-transform duration-150 ease-out active:scale-[0.98]"
          >
            {/* The mark: a small illuminated aperture. Career-Ops' own object rather than a wordmark
             *  in the default weight every SaaS rail uses. */}
            <span
              aria-hidden="true"
              className="relative grid h-5 w-5 shrink-0 place-items-center rounded-[6px] bg-[var(--accent)] shadow-[0_0_14px_var(--accent-soft)]"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-white/95" />
            </span>
            <span className="truncate text-[13px] font-semibold tracking-[-0.01em] text-primary">career-ops</span>
          </Link>
        )}
        {collapsed && (
          <span
            aria-hidden="true"
            className="mx-auto grid h-5 w-5 place-items-center rounded-[6px] bg-[var(--accent)] shadow-[0_0_14px_var(--accent-soft)]"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-white/95" />
          </span>
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
            <h2 className="mb-1.5 hidden items-center gap-2 px-2.5 text-[9px] font-semibold uppercase tracking-[0.13em] text-tertiary lg:flex">
              <span aria-hidden="true" className="h-px w-2.5 bg-[var(--border)]" />
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
                    className={`relative shrink-0 rounded-[7px] px-2.5 py-[7px] text-[13px] leading-5 transition-[background-color,color,box-shadow] duration-150 ease-out lg:block ${
                      active
                        ? "bg-[var(--z3-bg)] font-medium text-primary shadow-[var(--lift-1),inset_0_1px_0_var(--edge-hi)]"
                        : "font-normal text-secondary hover:bg-[var(--surface-hover)] hover:text-primary active:bg-[var(--surface-active)]"
                    }`}
                  >
                    {active && (
                      <span
                        aria-hidden="true"
                        className="absolute inset-y-1.5 -left-[7px] hidden w-[2px] rounded-full bg-[var(--accent)] shadow-[0_0_10px_var(--accent)] lg:block"
                      />
                    )}
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
      <div hidden={collapsed} className="shrink-0 p-3">
        {/* Inset identity block: recessed rather than raised, so persistent context reads as part
         *  of the rail's floor instead of competing with the navigation above it. */}
        <div className="rounded-[var(--radius-lg)] bg-[var(--z0-bg)] p-2.5 shadow-[inset_0_1px_2px_var(--edge-lo)]">
          <h2 className="mb-1.5 hidden text-[9px] font-semibold uppercase tracking-[0.13em] text-tertiary lg:block">
            Candidate
          </h2>
          <CandidateSelector />
        </div>
      </div>
    </motion.aside>
  );
}
