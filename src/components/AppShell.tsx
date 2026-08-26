"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { SetupProgressStrip } from "@/components/SetupProgressStrip";

/**
 * Chrome that only belongs to a signed-in session.
 *
 * The landing page asks "who's working" — showing it alongside the navigation rail, the toolbar and
 * a candidate selector is contradictory: it implies a profile is already active while asking you to
 * pick one, and it offers links into another person's workspace before anyone has unlocked
 * anything. So the shell renders nothing on that route and the page owns the whole viewport.
 */
const CHROMELESS_ROUTES = new Set(["/"]);

export function AppShell({
  sidebar,
  header,
  children,
}: {
  sidebar: ReactNode;
  header: ReactNode;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const bare = CHROMELESS_ROUTES.has(pathname);
  const productClass = pathname.startsWith("/admin") ? "admin-product" : "candidate-product";

  if (bare) {
    return (
      <main id="main-content" tabIndex={-1} className="flex-1 overflow-y-auto outline-none">
        <div className="mx-auto w-full max-w-[var(--home-max-w)] px-[var(--shell-pad)] py-6 lg:py-7">{children}</div>
      </main>
    );
  }

  return (
    <>
      {sidebar}
      <div className={`${productClass} flex min-h-0 min-w-0 flex-1 flex-col`}>
        {header}
        {/* Follows a running build across every page, so nobody meets an empty Jobs list and
         *  concludes the app is broken while their profile is still being read. */}
        <SetupProgressStrip />
        {/* UI-2 — the skip-link target. One stable id, present in this render path and the
         *  chromeless one above, so #main-content resolves to the same landmark on every route.
         *  `tabIndex={-1}` lets a fragment-navigated focus actually land here (not just scroll to
         *  it) without adding this element to the normal Tab order. */}
        <main id="main-content" tabIndex={-1} className="flex-1 overflow-y-auto outline-none">
          <div className="mx-auto w-full max-w-[var(--home-max-w)] px-[var(--shell-pad)] py-6 lg:py-7">{children}</div>
        </main>
      </div>
    </>
  );
}
