"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

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

  if (bare) {
    return (
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1600px] px-6 py-6 lg:px-8 lg:py-7">{children}</div>
      </main>
    );
  }

  return (
    <>
      {sidebar}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {header}
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[1600px] px-6 py-6 lg:px-8 lg:py-7">{children}</div>
        </main>
      </div>
    </>
  );
}
