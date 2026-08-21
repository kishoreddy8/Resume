import type { Metadata } from "next";
import { ProfileLockPrompt } from "@/components/ProfileLockPrompt";
import { AppShell } from "@/components/AppShell";
import { CommandBar } from "@/components/CommandBar";
import { Geist, Geist_Mono } from "next/font/google";
import { AppSidebar } from "@/components/AppSidebar";
import { NotificationBell } from "@/components/NotificationBell";
import { HeaderSearch } from "@/components/HeaderSearch";
import { APP_TOOLBAR_ACTIONS_SLOT_ID, APP_TOOLBAR_SLOT_ID } from "@/components/AppToolbarSlot";
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
  /**
   * Stop iOS Safari rewriting our own text into links.
   *
   * iOS runs data detectors over rendered text and silently converts anything that looks like a
   * phone number, a date, an email or an address into an <a> — mutating a DOM React believes it
   * owns, which surfaces as "Text content does not match server-rendered HTML". This app is full of
   * exactly that bait: the profile identity card prints a phone number and an email, application
   * rows print relative times, and the resume library prints dates.
   *
   * This is not a hydration-warning suppression. suppressHydrationWarning tells React to ignore a
   * real difference; this tells the BROWSER not to create one, so server and client keep rendering
   * the same text. Contact details stay selectable and copyable — they simply stop being
   * auto-linked, which is also why the phone number no longer becomes a tap-to-call target on a
   * page whose job is to show you what a resume says.
   */
  formatDetection: { telephone: false, date: false, email: false, address: false },
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
            <header className="relative z-30 flex h-[60px] shrink-0 items-center border-b border-[var(--header-border)] bg-[color-mix(in_oklab,var(--z1-bg)_92%,transparent)] backdrop-blur-sm lg:h-[80px]">
              {/* EXACTLY the page body's container maths — cap first, then pad inside it, from the
               *  same two tokens AppShell reads. The header used to pad outside its cap while the
               *  body padded inside a different one, so the two bands were 62px out of step at
               *  2000px and the bell overhung the rail it is supposed to sit above. */}
              <div className="mx-auto flex h-full w-full max-w-[var(--home-max-w)] items-center gap-3 px-[var(--shell-pad)]">
                {/* Left of the search: the page's identity. In the flow, not absolutely placed, so
                 *  it can never be overlapped by the field beside it. It shrinks before the search
                 *  does and truncates rather than pushing. */}
                <div
                  id={APP_TOOLBAR_SLOT_ID}
                  className="flex min-w-0 shrink items-center gap-3 empty:hidden"
                />
                {/* Centres over the MAIN column rather than the viewport, because the right cell
                 *  below reserves the rail's width. Centring on the viewport put the field visibly
                 *  right of where the content actually is. */}
                <div className="flex min-w-0 flex-1 justify-center">
                  <HeaderSearch />
                </div>
                <div className="flex shrink-0 items-center justify-end gap-2 xl:w-[var(--home-rail-w)]">
                  {/* Right of the search: what the page can do. */}
                  <div
                    id={APP_TOOLBAR_ACTIONS_SLOT_ID}
                    className="flex shrink-0 items-center gap-1.5 empty:hidden"
                  />
                  {/* ONE instance. A second copy for the narrow layout mounted a second bell, and
                   *  each one fetches its own notifications — two identical requests per page load
                   *  for a control that is only ever visible once. It is one element that changes
                   *  width instead. */}
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
