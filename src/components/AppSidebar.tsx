"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import { CandidateSelector } from "@/components/CandidateSelector";
import { AdminRailLink } from "@/components/AdminRailLink";
import {
  IconBriefcase,
  IconBuilding,
  IconDashboard,
  IconDocument,
  IconHome,
  IconInbox,
  IconActivity,
  IconPenTool,
  IconScanner,
  IconServer,
  IconSettings,
  IconSparkle,
  IconUser,
} from "@/components/icons";

/**
 * JobHunt's primary navigation.
 *
 * TWO PRODUCTS, ONE SHELL. A job seeker gets six destinations about their own search. Everything
 * that manages the machinery — connectors, scan runs, company registry, system health — lives under
 * /admin and only appears once you are there. Previously they shared one rail, which is what made
 * a personal job-search tool feel like somebody's internal console: a candidate looking for work
 * does not need "ATS Coverage" between "Jobs" and "Settings".
 *
 * The admin rail is not hidden to be secret. The real boundary is server-side, on the APIs those
 * pages call; this is about what a person should be asked to think about.
 *
 * NO CATEGORY HEADINGS ON THE CANDIDATE RAIL. Six destinations do not need to be sorted into
 * "Search" and "You" — the headings were shelf labels on a shelf with three things on it, and they
 * are the single detail that made a consumer product read as an internal console. The operator rail
 * keeps its groups, because thirteen system destinations genuinely do need sorting.
 *
 * ICONS ARE THE RAIL'S OWN (see components/icons.tsx) — one grid, one stroke weight, no library.
 * Each one sits beside its label rather than replacing it: the label is what makes a destination
 * predictable before you click it, and the glyph is what makes it findable at a glance.
 *
 * One component serves both layouts. Below `lg` the same tree reflows into a stacked strip along
 * the top (the items become one scrollable row); at `lg` and above it is the persistent left
 * column. It is built this way rather than as two components so that CandidateSelector mounts
 * exactly once — a second copy hidden by CSS would still run its own fetches and hold its own
 * state, which is a behaviour change, not a layout one.
 */

interface NavItem {
  href: string;
  label: string;
  icon?: ReactNode;
  /** Sub-routes that should keep this item selected (e.g. a job detail page). */
  matchPrefix?: RegExp;
}

interface NavGroup {
  title: string;
  /** Operator groups print their heading. The candidate rail does not — see the note above. */
  showTitle?: boolean;
  items: NavItem[];
}

/** What a job seeker sees. Six destinations, each about their own search. */
const USER_NAV: NavGroup[] = [
  {
    title: "Primary",
    items: [
      { href: "/home", label: "Home", icon: <IconHome size={20} /> },
      { href: "/jobs", label: "Jobs", icon: <IconBriefcase size={20} />, matchPrefix: /^\/jobs\/\d+$/ },
      { href: "/resume", label: "Resume Studio", icon: <IconDocument size={20} /> },
      {
        href: "/applications",
        label: "Applications",
        icon: <IconInbox size={20} />,
        matchPrefix: /^\/applications\/\d+$/,
      },
      { href: "/profile", label: "Profile", icon: <IconUser size={20} /> },
      { href: "/settings", label: "Settings", icon: <IconSettings size={20} /> },
    ],
  },
];

/** What an operator sees. Only rendered under /admin. */
const ADMIN_NAV: NavGroup[] = [
  {
    title: "Monitor",
    showTitle: true,
    items: [
      { href: "/admin", label: "Overview", icon: <IconDashboard size={20} /> },
      { href: "/admin/companies", label: "Companies", icon: <IconBuilding size={20} /> },
      { href: "/admin/scanner", label: "Scanner", icon: <IconScanner size={20} /> },
      { href: "/admin/writer", label: "Resume Writer", icon: <IconPenTool size={20} /> },
      { href: "/admin/applications", label: "Applications", icon: <IconBriefcase size={20} /> },
    ],
  },
  {
    title: "Manage",
    showTitle: true,
    items: [
      { href: "/admin/operations", label: "Operations", icon: <IconServer size={20} /> },
      { href: "/admin/settings", label: "Settings", icon: <IconSettings size={20} /> },
      { href: "/admin/activity", label: "Activity", icon: <IconActivity size={20} /> },
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
  /* Admin is a different product with a different rail. Derived from the path so a link into
   * /admin swaps the navigation with it, and leaving swaps it back. */
  const inAdmin = pathname.startsWith("/admin");
  const groups = inAdmin ? ADMIN_NAV : USER_NAV;
  const collapsed = desktop && !open;
  const [adminMenuOpen, setAdminMenuOpen] = useState(false);
  const adminDialogRef = useRef<HTMLDialogElement>(null);
  const adminMenuButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dialog = adminDialogRef.current;
    if (!dialog) return;
    if (inAdmin && adminMenuOpen && !dialog.open) dialog.showModal();
    if ((!adminMenuOpen || !inAdmin) && dialog.open) dialog.close();
  }, [adminMenuOpen, inAdmin]);

  /* Below `lg` this nav is a horizontal strip, not a column, and six destinations do not all fit at
   * 390px — Resume Studio/Profile/Settings clipped clean off the edge with no sign anything was
   * off-screen. Same fix as the job workflow stepper: a fade that only appears when there is
   * genuinely more, plus real arrow controls, so a mouse-only visitor (not just a swipe/keyboard
   * one) can reach every destination. Both are suppressed at `lg` and up, where this same element
   * is a vertical column and horizontal overflow does not apply. */
  const navRef = useRef<HTMLElement>(null);
  const [overflow, setOverflow] = useState({ left: false, right: false });

  const measure = useCallback(() => {
    const el = navRef.current;
    if (!el) return;
    setOverflow({
      left: el.scrollLeft > 1,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1,
    });
  }, []);

  useEffect(() => {
    const el = navRef.current;
    if (!el) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    el.addEventListener("scroll", measure, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", measure);
    };
  }, [measure, groups]);

  function pageNav(direction: -1 | 1) {
    const el = navRef.current;
    if (!el) return;
    el.scrollBy({ left: direction * Math.max(120, el.clientWidth * 0.75), behavior: reduced ? "auto" : "smooth" });
  }

  if (inAdmin) {
    const adminLinks = (onNavigate?: () => void) =>
      ADMIN_NAV.map((group) => (
        <div key={group.title} className="mb-6 last:mb-0">
          <h2 className="mb-2 px-3 text-[12.5px] font-semibold uppercase tracking-[0.09em] text-tertiary">
            {group.title}
          </h2>
          <div className="flex flex-col gap-1">
            {group.items.map((item) => {
              const active = isNavItemActive(item, pathname);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  onClick={onNavigate}
                  className={`relative flex min-h-12 items-center gap-3 rounded-[11px] px-3 text-[15px] font-medium transition-[background-color,color,transform] duration-150 active:scale-[0.985] ${
                    active
                      ? "bg-[var(--accent-tint)] font-semibold text-[var(--accent)]"
                      : "text-secondary hover:bg-[var(--surface-hover)] hover:text-primary"
                  }`}
                >
                  {active && <span aria-hidden="true" className="absolute inset-y-3 -left-3 w-[3px] rounded-r-full bg-[var(--accent)]" />}
                  <span aria-hidden="true" className="shrink-0">{item.icon}</span>
                  {item.label}
                </Link>
              );
            })}
          </div>
        </div>
      ));

    return (
      <aside className="z-50 w-full shrink-0 border-b border-[var(--rail-border)] bg-[var(--z1-bg)] lg:h-dvh lg:w-64 lg:border-b-0 lg:border-r">
        <div className="flex h-[60px] items-center justify-between px-4 lg:hidden">
          <Link href="/admin" className="flex items-center gap-2.5 rounded-md">
            <span aria-hidden="true" className="grid h-8 w-8 place-items-center rounded-[8px] bg-[var(--accent)] text-[15px] font-bold text-white">C</span>
            <span className="text-[17px] font-bold tracking-[-0.018em] text-primary">Career-Ops <span className="font-medium text-tertiary">Admin</span></span>
          </Link>
          <button
            ref={adminMenuButtonRef}
            type="button"
            aria-haspopup="dialog"
            aria-expanded={adminMenuOpen}
            onClick={() => setAdminMenuOpen(true)}
            className="grid h-11 w-11 place-items-center rounded-[10px] border border-[var(--border)] bg-[var(--z2-bg)] text-[20px] text-primary"
          >
            <span className="sr-only">Open Admin navigation</span>
            <span aria-hidden="true">☰</span>
          </button>
        </div>

        <dialog
          ref={adminDialogRef}
          aria-label="Admin navigation"
          className="fixed inset-y-0 left-0 m-0 h-dvh w-[min(320px,88vw)] max-h-none max-w-none border-0 bg-[var(--z1-bg)] p-0 text-primary shadow-2xl backdrop:bg-slate-950/45 lg:hidden"
          onCancel={(event) => {
            event.preventDefault();
            setAdminMenuOpen(false);
          }}
          onClose={() => {
            setAdminMenuOpen(false);
            queueMicrotask(() => adminMenuButtonRef.current?.focus());
          }}
        >
          <div className="flex h-full flex-col">
            <div className="flex h-[68px] items-center justify-between border-b border-[var(--border)] px-5">
              <span className="text-[18px] font-bold">Admin Console</span>
              <button type="button" aria-label="Close Admin navigation" onClick={() => setAdminMenuOpen(false)} className="grid h-11 w-11 place-items-center rounded-[10px] hover:bg-[var(--surface-hover)]">×</button>
            </div>
            <nav aria-label="Admin" className="flex-1 overflow-y-auto px-5 py-6">{adminLinks(() => setAdminMenuOpen(false))}</nav>
            <div className="border-t border-[var(--border)] p-4">
              <Link href="/home" onClick={() => setAdminMenuOpen(false)} className="flex min-h-12 items-center rounded-[10px] px-3 text-[14px] font-semibold text-secondary hover:bg-[var(--surface-hover)] hover:text-primary">← Return to candidate workspace</Link>
            </div>
          </div>
        </dialog>

        <div className="hidden h-full flex-col lg:flex">
          <div className="flex h-[80px] shrink-0 items-center gap-2.5 border-b border-[var(--separator)] px-5">
            <span aria-hidden="true" className="grid h-9 w-9 place-items-center rounded-[9px] bg-[var(--accent)] text-[16px] font-bold text-white">C</span>
            <div>
              <p className="text-[17px] font-bold tracking-[-0.018em] text-primary">Career-Ops</p>
              <p className="text-[13px] font-medium text-tertiary">Admin Console</p>
            </div>
          </div>
          <nav aria-label="Admin" className="flex-1 overflow-y-auto px-5 py-7">{adminLinks()}</nav>
          <div className="border-t border-[var(--separator)] p-4">
            <Link href="/home" className="flex min-h-12 items-center rounded-[10px] px-3 text-[14px] font-semibold text-secondary hover:bg-[var(--surface-hover)] hover:text-primary">← Candidate workspace</Link>
          </div>
        </div>
      </aside>
    );
  }

  const navArrow =
    "absolute top-1/2 z-10 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-[10px] bg-[var(--z1-bg)] text-[17px] text-tertiary shadow-[0_0_10px_4px_var(--z1-bg)] transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] hover:text-primary active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:pointer-events-none disabled:opacity-0 lg:hidden";

  return (
    <motion.aside
      initial={false}
      /* Motion retains the last animated inline width when `animate` becomes an empty object.
       * Explicitly return to 100% below `lg`, otherwise resizing from desktop can leave the rail
       * wider than the mobile viewport and push the workspace off-screen. */
      animate={{ width: desktop ? (open ? 264 : 48) : "100%" }}
      transition={reduced ? { duration: 0 } : { type: "spring", duration: 0.28, bounce: 0 }}
      className="flex w-full shrink-0 flex-col overflow-hidden border-b border-[var(--rail-border)] bg-[var(--z1-bg)] lg:h-full lg:min-h-dvh lg:border-b-0 lg:border-r lg:pb-[18px] lg:pt-[20px]"
    >
      <div className="flex h-12 shrink-0 items-center gap-1 px-4 lg:h-[42px] lg:px-4">
        {!collapsed && (
          <Link
            href={inAdmin ? "/admin" : "/home"}
            className="group flex min-w-0 items-center gap-2.5 rounded-md transition-transform duration-150 ease-out active:scale-[0.98]"
          >
            {/* The mark: a small illuminated aperture. JobHunt's own object rather than a wordmark
             *  in the default weight every SaaS rail uses. */}
            <span
              aria-hidden="true"
              className="relative grid h-8 w-8 shrink-0 place-items-center rounded-[8px] bg-[var(--accent)] text-[15px] font-bold text-white"
            >
              C
            </span>
            <span className="truncate text-[18px] font-bold tracking-[-0.018em] text-primary">
              Career-Ops
              {inAdmin && (
                <span className="ml-1.5 text-[10px] font-normal uppercase tracking-[0.09em] text-tertiary">
                  admin
                </span>
              )}
            </span>
          </Link>
        )}
        {collapsed && (
          <span
            aria-hidden="true"
            className="mx-auto grid h-8 w-8 place-items-center rounded-[8px] bg-[var(--accent)] text-[15px] font-bold text-white"
          >
            C
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
          <span aria-hidden="true">{open ? "◀" : "▶"}</span>
        </button>
      </div>

      <div hidden={collapsed} className="relative">
        <button
          type="button"
          onClick={() => pageNav(-1)}
          disabled={!overflow.left}
          aria-label="Scroll navigation left"
          className={`${navArrow} left-1`}
        >
          <span aria-hidden="true">‹</span>
        </button>

        <nav
          ref={navRef}
          aria-label="Primary"
          className={`flex gap-1 overflow-x-auto px-3 pb-2 lg:mt-[30px] lg:flex-col lg:gap-0 lg:overflow-x-visible lg:overflow-y-auto lg:px-4 lg:pb-4 ${
            !desktop && overflow.right ? "scroll-fade-x" : "scroll-fade-none"
          }`}
        >
        {groups.map((group) => (
          // `contents` lets the items join the horizontal row directly on narrow
          // screens while staying a block in the sidebar.
          <div key={group.title} className="contents lg:mb-5 lg:block lg:last:mb-0">
            {group.showTitle && (
              <h2 className="mb-1.5 hidden items-center gap-2 px-2.5 text-[9px] font-semibold uppercase tracking-[0.13em] text-tertiary lg:flex">
                <span aria-hidden="true" className="h-px w-2.5 bg-[var(--border)]" />
                {group.title}
              </h2>
            )}
            <div className={`contents lg:flex lg:flex-col ${inAdmin ? "lg:gap-[5px]" : "lg:gap-1.5"}`}>
              {group.items.map((item) => {
                const active = isNavItemActive(item, pathname);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={`relative flex shrink-0 items-center gap-3 whitespace-nowrap rounded-[10px] px-3 leading-5 transition-[background-color,color,box-shadow,transform] duration-150 ease-out active:scale-[0.985] ${
                      inAdmin ? "h-11 text-[14px] font-medium" : "h-12 text-[15.5px]"
                    } ${
                      active
                        ? "bg-[var(--accent-tint)] font-semibold text-[var(--accent)] shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--accent)_8%,transparent)]"
                        : "font-medium text-secondary hover:bg-[var(--surface-hover)] hover:text-primary active:bg-[var(--surface-active)]"
                    }`}
                  >
                    {active && (
                      <span
                        aria-hidden="true"
                        className="absolute inset-y-2.5 -left-4 hidden w-[3px] rounded-r-full bg-[var(--accent)] lg:block"
                      />
                    )}
                    {item.icon && (
                      <span aria-hidden="true" className="shrink-0">
                        {item.icon}
                      </span>
                    )}
                    {item.label}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
        </nav>

        <button
          type="button"
          onClick={() => pageNav(1)}
          disabled={!overflow.right}
          aria-label="Scroll navigation right"
          className={`${navArrow} right-1`}
        >
          <span aria-hidden="true">›</span>
        </button>
      </div>

      {/* The lower utility cluster: assistant, account, admin — in that order.
       *
       *  ONE `mt-auto` HOLDS ALL THREE. They were previously two siblings, one of which carried the
       *  auto margin, which is what let the Copilot drift up against the navigation. Grouping them
       *  means the free space in the column collects in exactly one place — above this cluster —
       *  so the whole group sits at the foot of a tall rail and stays together on a short one.
       *  Nothing here is absolutely positioned; it is ordinary flex flow.
       *
       *  Each child keeps the padding it already had, so grouping them moves the cluster without
       *  resizing anything inside it. */}
      <div hidden={collapsed} className="shrink-0 lg:mt-auto">
        {/* IT RUNS ONLY WHEN ASKED. There is no assistant on this page — nothing is prefetched, no
         *  model is called on load, and this card is a door. The assistant itself is grounded in
         *  one job's evidence and lives on the job (see jobs/[id]/AskAboutJob), which is why the
         *  door opens onto Jobs and the copy says so rather than promising a chat that is not
         *  there. */}
        {!inAdmin && (
          <div className="hidden shrink-0 px-3 pb-2.5 lg:block">
            <div className="rounded-[14px] border border-[#E7E5FF] bg-[var(--accent-tint-weak)] p-[15px] dark:border-[var(--border)]">
              <h2 className="flex items-center gap-2 text-[13px] font-bold text-primary">
                <span aria-hidden="true" className="text-[var(--accent)]">
                  <IconSparkle size={16} />
                </span>
                AI Career Copilot
              </h2>
              <p className="mt-2 text-[13px] leading-[1.5] text-tertiary">
                Ask why a job matches your evidence, from any job.
              </p>
              <Link
                href="/jobs"
                className="mt-3 grid h-11 place-items-center rounded-[9px] bg-[var(--accent)] text-center text-[14px] font-semibold text-[var(--accent-fg)] transition-[background-color,transform] duration-150 ease-out hover:bg-[var(--accent-hover)] active:scale-[0.98]"
              >
                Ask Copilot
              </Link>
            </div>
          </div>
        )}

        {/* Account area — the active candidate is persistent context, not a page
         *  action, so it sits at the foot of the shell rather than in the toolbar. */}
        <div className="shrink-0 px-3 pb-0 pt-1 lg:px-4">
          <CandidateSelector />
          {/* Owner-only, and the way back out again. Without it admin had no door at all. */}
          <AdminRailLink />
        </div>
      </div>
    </motion.aside>
  );
}
