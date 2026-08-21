import type { Metadata } from "next";
import { ProfileLockPrompt } from "@/components/ProfileLockPrompt";
import { AppShell } from "@/components/AppShell";
import { CommandBar } from "@/components/CommandBar";
import { Geist, Geist_Mono } from "next/font/google";
import { AppSidebar } from "@/components/AppSidebar";
import { NotificationBell } from "@/components/NotificationBell";
import { HeaderSearch } from "@/components/HeaderSearch";
import { APP_TOOLBAR_SLOT_ID } from "@/components/AppToolbarSlot";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "JobHunt",
  description: "Personal job-search pipeline",
};

/**
 * CareerOps UI Stage 1 — the application shell.
 *
 * A fixed-height two-column desktop layout: a persistent sidebar that never
 * scrolls away, and a content column that owns its own scrolling. The toolbar
 * therefore sits above the scroll container rather than floating over it, which
 * is why nothing here uses a translucent blurred bar — there is no content
 * passing underneath for a material to reveal, and a blur behind dense job
 * tables would cost legibility for no gain.
 */
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="app-canvas flex h-full flex-col overflow-hidden text-primary lg:flex-row">
        <AppShell
          sidebar={<AppSidebar />}
          header={
            /* Toolbar. Pages portal their title and primary actions into the slot (see
             *  AppToolbarSlot); the bell stays pinned right. A page that renders nothing into the
             *  slot simply leaves it empty, exactly as before. */
            <header className="relative z-30 flex h-14 shrink-0 items-center border-b border-[var(--header-border)] bg-[color-mix(in_oklab,var(--z1-bg)_92%,transparent)] px-4 backdrop-blur-sm lg:h-[72px] lg:px-8">
              {/* Pages portal their title and primary actions here. It is pinned to the left edge
               *  rather than placed in the row so that adding a long page title cannot shift the
               *  search field off the main column's centre line. */}
              <div
                id={APP_TOOLBAR_SLOT_ID}
                className="pointer-events-none absolute inset-y-0 left-4 flex max-w-[26%] items-center gap-3 lg:left-8 [&>*]:pointer-events-auto"
              />
              {/* The same container geometry as the page body — max width, gutter, rail width and
               *  gap — so the field centres over the MAIN column, not over the viewport. Centring
               *  it on the viewport put it visibly right of where the content actually is. */}
              <div className="mx-auto flex h-full w-full max-w-[var(--home-max-w)] items-center gap-[var(--home-rail-gap)]">
                <div className="flex min-w-0 flex-1 justify-center">
                  <HeaderSearch />
                </div>
                {/* ONE instance. A second copy for the narrow layout mounted a second bell, and
                 *  each one fetches its own notifications — two identical requests per page load
                 *  for a control that is only ever visible once. It is one element that changes
                 *  width instead. */}
                <div className="flex shrink-0 justify-end xl:w-[var(--home-rail-w)]">
                  <NotificationBell />
                </div>
              </div>
            </header>
          }
        >
          {children}
        </AppShell>
        {/* Global ⌘K. Renders nothing until opened. */}
        <CommandBar />
        {/* Catches any 401 from a locked profile and offers the PIN, so no page is a dead end. */}
        <ProfileLockPrompt />
      </body>
    </html>
  );
}
