"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useActiveCandidateId } from "@/lib/useActiveCandidateId";
import { IconBell } from "@/components/icons";
import type { NotificationResponseEntry } from "@/app/api/candidates/[candidateId]/notifications/route";

/**
 * Phase 4 Stage 4 — header bell icon + dropdown inbox for candidate job-match notifications. Small,
 * self-contained, next to CandidateSelector in the header (see src/app/layout.tsx) — no navigation
 * redesign. Re-fetches whenever the active candidate id changes, so switching candidates in
 * CandidateSelector always shows THAT candidate's own unread count, never a stale/global one.
 */
/** Compact relative age. Reads `createdAt`, which the route already returns — no new request. */
function ago(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return mins + "m";
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + "h";
  const days = Math.floor(hrs / 24);
  if (days < 7) return days + "d";
  return Math.floor(days / 7) + "w";
}

export function NotificationBell() {
  const candidateId = useActiveCandidateId();
  const [notifications, setNotifications] = useState<NotificationResponseEntry[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const reduced = useReducedMotion() ?? false;

  async function load() {
    const res = await fetch(`/api/candidates/${candidateId}/notifications?limit=20`);
    if (!res.ok) return;
    const body = await res.json();
    setNotifications(body.notifications ?? []);
    setUnreadCount(body.unreadCount ?? 0);
  }

  useEffect(() => {
    // Intentional: fetch-on-mount/candidate-change with no dependency loop.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidateId]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    // Escape closes and returns focus to the bell, matching the filter panel and the dock menu —
    // three popovers that used to dismiss three different ways.
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen((wasOpen) => {
          if (wasOpen) triggerRef.current?.focus();
          return false;
        });
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKey);
    };
  }, []);

  async function handleOpen() {
    const next = !open;
    setOpen(next);
    if (next) await load(); // refresh on open so a just-completed scan's notifications show up
  }

  async function markRead(notificationId: number) {
    setNotifications((prev) => prev.map((n) => (n.id === notificationId ? { ...n, readAt: new Date().toISOString() } : n)));
    setUnreadCount((prev) => Math.max(0, prev - 1));
    await fetch(`/api/candidates/${candidateId}/notifications/${notificationId}`, { method: "PATCH" });
  }

  async function markAllRead() {
    setNotifications((prev) => prev.map((n) => (n.readAt ? n : { ...n, readAt: new Date().toISOString() })));
    setUnreadCount(0);
    await fetch(`/api/candidates/${candidateId}/notifications/mark-all-read`, { method: "POST" });
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={handleOpen}
        className="relative grid h-9 w-9 place-items-center rounded-full text-secondary transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] hover:text-primary active:scale-[0.97] active:bg-[var(--surface-active)]"
        title="Notifications"
        aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications"}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        {/* A line glyph on the same grid as the rail's icons, replacing the emoji — an emoji renders
         *  in the platform's own style and weight, which is the one thing an icon set cannot have. */}
        <IconBell size={19} />
        {unreadCount > 0 && (
          <span
            aria-hidden="true"
            className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--error)] px-1 text-[10px] font-semibold leading-none text-white ring-2 ring-[var(--z1-bg)]"
          >
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {/* Z5, origin-aware: the inbox scales out of the bell, on the same spring as the filter
       *  panel and the dock menu. Three popovers, one behaviour. */}
      <AnimatePresence>
        {open && (
          <motion.div
            role="dialog"
            aria-label="Notifications"
            style={{ transformOrigin: "top right" }}
            initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: -6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.98, y: -4 }}
            transition={reduced ? { duration: 0.11 } : { type: "spring", duration: 0.22, bounce: 0 }}
            className="plane plane-5 absolute right-0 z-50 mt-2 w-[21rem] overflow-hidden"
          >
            {/* Header sits on the panel's own lit edge rather than a drawn rule, so the inbox
             *  reads as one Z5 surface with a lip, not as two stacked boxes. */}
            <div className="flex items-center justify-between px-3.5 pb-2 pt-3">
              <span className="text-[11px] font-semibold uppercase tracking-[0.09em] text-tertiary">
                Notifications
              </span>
              {unreadCount > 0 && (
                <button
                  type="button"
                  onClick={markAllRead}
                  className="rounded-md px-1.5 py-0.5 text-[11px] text-secondary transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] hover:text-primary active:scale-[0.97]"
                >
                  Mark all read
                </button>
              )}
            </div>

            <div className="max-h-[26rem] overflow-y-auto border-t border-[var(--separator)]">
              {notifications.length === 0 && (
                <div className="px-4 py-9 text-center">
                  <p className="text-[12.5px] font-medium text-secondary">No notifications</p>
                  <p className="mt-1 text-[11.5px] leading-relaxed text-tertiary">
                    A scan that turns up new matches for this candidate will post here.
                  </p>
                </div>
              )}
              {notifications.map((n) => (
                <div
                  key={n.id}
                  className={`group relative border-b border-[var(--separator)] py-2.5 pl-4 pr-3.5 last:border-b-0 transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] ${
                    n.readAt ? "opacity-70" : ""
                  }`}
                >
                  {/* Unread is an edge of light — the same vocabulary the selected job row uses.
                   *  Restraint is deliberate: a tinted block per unread item turns a 20-item inbox
                   *  into a wall of colour and stops distinguishing anything. */}
                  {!n.readAt && (
                    <span
                      aria-hidden="true"
                      className="absolute inset-y-1.5 left-0 w-[2px] rounded-r-full bg-[var(--accent)]"
                    />
                  )}
                  <div className="flex items-baseline gap-2">
                    <span
                      className={`min-w-0 flex-1 truncate text-[12.5px] ${
                        n.readAt ? "font-medium text-secondary" : "font-semibold text-primary"
                      }`}
                    >
                      {n.title}
                    </span>
                    <span className="shrink-0 text-[10.5px] tabular-nums text-tertiary">{ago(n.createdAt)}</span>
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-relaxed text-tertiary">{n.body}</p>
                  <div className="mt-1.5 flex items-center gap-3">
                    {n.jobId !== null && (
                      <Link
                        href={`/jobs/${n.jobId}`}
                        onClick={() => !n.readAt && markRead(n.id)}
                        className="text-[11px] font-medium text-[var(--accent)] transition-opacity duration-150 ease-out hover:opacity-80"
                      >
                        View job
                      </Link>
                    )}
                    {!n.readAt && (
                      <button
                        type="button"
                        onClick={() => markRead(n.id)}
                        /* Revealed on hover/focus so a read inbox is quiet, but never keyboard-only
                         *  invisible — focus-within brings it back for tab users. */
                        className="text-[11px] text-tertiary opacity-0 transition-opacity duration-150 ease-out focus-visible:opacity-100 group-hover:opacity-100"
                      >
                        Mark read
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
