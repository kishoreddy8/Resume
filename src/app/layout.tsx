import type { Metadata } from "next";
import { ProfileLockPrompt } from "@/components/ProfileLockPrompt";
import { AppShell } from "@/components/AppShell";
import { CommandBar } from "@/components/CommandBar";
import { Geist, Geist_Mono } from "next/font/google";
import { AppSidebar } from "@/components/AppSidebar";
import { NotificationBell } from "@/components/NotificationBell";
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
            <header className="relative z-30 flex h-12 shrink-0 items-center gap-3 border-b border-[var(--separator)] bg-[var(--z1-bg)] px-4 lg:h-14 lg:px-6">
              <div id={APP_TOOLBAR_SLOT_ID} className="flex min-w-0 flex-1 items-center gap-3" />
              <NotificationBell />
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
