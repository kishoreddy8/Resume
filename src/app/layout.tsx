import type { Metadata } from "next";
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
  title: "Career Ops",
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
      <body className="flex h-full flex-col overflow-hidden bg-app-bg text-primary lg:flex-row">
        <AppSidebar />

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* Toolbar. Pages portal their title and primary actions into the slot (see
           *  AppToolbarSlot); the bell stays pinned right. A page that renders nothing into the
           *  slot simply leaves it empty, exactly as before. */}
          <header className="relative z-30 flex h-12 shrink-0 items-center gap-3 border-b border-[var(--separator)] bg-surface px-4 lg:h-14 lg:px-6">
            <div id={APP_TOOLBAR_SLOT_ID} className="flex min-w-0 flex-1 items-center gap-3" />
            <NotificationBell />
          </header>

          <main className="flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-[1600px] px-6 py-6 lg:px-8 lg:py-7">
              {children}
            </div>
          </main>
        </div>
      </body>
    </html>
  );
}
