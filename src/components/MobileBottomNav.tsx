"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion, useReducedMotion } from "motion/react";
import { MOTION_NORMAL } from "@/lib/motion/tokens";
import { IconHome, IconBriefcase, IconInbox, IconActivity, IconUser, type IconProps } from "@/components/icons";

/**
 * UI-M — the mobile primary navigation. Frozen contract: exactly these five destinations, in this
 * order. Admin is deliberately absent — it keeps its own existing mobile pattern (the hamburger
 * dialog in AppSidebar) and is desktop/operator-oriented, not part of this five-tab set.
 *
 * Replaces AppSidebar's candidate rail below `lg` (which now renders nothing there — see
 * AppSidebar.tsx) rather than existing alongside it; a phone never shows two navigation surfaces.
 */
interface MobileNavItem {
  href: string;
  label: string;
  icon: (p: IconProps) => React.ReactElement;
  /** Sub-routes that should keep this tab active (a job/application detail page). */
  matchPrefix?: RegExp;
}

const MOBILE_NAV_ITEMS: MobileNavItem[] = [
  { href: "/home", label: "Home", icon: IconHome },
  { href: "/jobs", label: "Jobs", icon: IconBriefcase, matchPrefix: /^\/jobs(\/|$)/ },
  { href: "/applications", label: "Applications", icon: IconInbox, matchPrefix: /^\/applications(\/|$)/ },
  { href: "/activity", label: "Activity", icon: IconActivity },
  { href: "/profile", label: "Profile", icon: IconUser },
];

/** Exact match, plus an optional prefix for detail routes — same rule AppSidebar's own
 *  `isNavItemActive` uses, so "active" never means two different things in the same app. */
function isMobileNavItemActive(item: MobileNavItem, pathname: string): boolean {
  if (pathname === item.href) return true;
  return item.matchPrefix ? item.matchPrefix.test(pathname) : false;
}

export function MobileBottomNav() {
  const pathname = usePathname();
  const reduced = useReducedMotion() ?? false;

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-[var(--rail-border)] bg-[var(--z1-bg)] pb-[env(safe-area-inset-bottom)] lg:hidden"
    >
      <ul className="flex items-stretch justify-around">
        {MOBILE_NAV_ITEMS.map((item) => {
          const active = isMobileNavItemActive(item, pathname);
          const Icon = item.icon;
          return (
            <li key={item.href} className="min-w-0 flex-1">
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`relative flex min-h-[56px] flex-col items-center justify-center gap-0.5 px-1 py-1.5 text-[11px] transition-colors duration-150 ease-out active:scale-[0.97] ${
                  active ? "font-semibold text-[var(--accent)]" : "font-medium text-tertiary"
                }`}
              >
                {/* The one moving part — a top-edge bar that slides between tabs rather than
                 *  appearing/disappearing, same layoutId idiom WorkflowRail already uses. Reduced
                 *  motion drops straight to a plain static bar: no shared-layout tween at all. */}
                {active &&
                  (reduced ? (
                    <span aria-hidden="true" className="absolute inset-x-[30%] top-0 h-[3px] rounded-full bg-[var(--accent)]" />
                  ) : (
                    <motion.span
                      layoutId="mobile-nav-indicator"
                      aria-hidden="true"
                      transition={MOTION_NORMAL}
                      className="absolute inset-x-[30%] top-0 h-[3px] rounded-full bg-[var(--accent)]"
                    />
                  ))}
                <Icon size={22} />
                <span className="truncate">{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
