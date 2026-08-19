"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useActiveCandidateId } from "@/lib/useActiveCandidateId";
import type { NotificationResponseEntry } from "@/app/api/candidates/[candidateId]/notifications/route";

/**
 * Phase 4 Stage 4 — header bell icon + dropdown inbox for candidate job-match notifications. Small,
 * self-contained, next to CandidateSelector in the header (see src/app/layout.tsx) — no navigation
 * redesign. Re-fetches whenever the active candidate id changes, so switching candidates in
 * CandidateSelector always shows THAT candidate's own unread count, never a stale/global one.
 */
export function NotificationBell() {
  const candidateId = useActiveCandidateId();
  const [notifications, setNotifications] = useState<NotificationResponseEntry[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

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
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
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
        type="button"
        onClick={handleOpen}
        className="relative rounded-md border border-[var(--border)] px-2 py-1 text-sm transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] active:bg-[var(--surface-active)]"
        title="Notifications"
        aria-label="Notifications"
        aria-expanded={open}
      >
        🔔
        {unreadCount > 0 && (
          <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold leading-none text-white">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-20 mt-2 w-80 rounded-lg border border-[var(--border)] bg-surface-elevated shadow-[var(--shadow-md)]">
          <div className="flex items-center justify-between border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
            <span className="text-sm font-semibold">Notifications</span>
            {unreadCount > 0 && (
              <button type="button" onClick={markAllRead} className="text-xs text-blue-600 hover:underline dark:text-blue-400">
                Mark all as read
              </button>
            )}
          </div>
          <div className="max-h-96 overflow-y-auto">
            {notifications.length === 0 && (
              <div className="px-3 py-6 text-center text-sm text-zinc-500">No notifications yet.</div>
            )}
            {notifications.map((n) => (
              <div
                key={n.id}
                className={`border-b border-zinc-100 px-3 py-2 text-sm last:border-b-0 dark:border-zinc-800 ${
                  n.readAt ? "opacity-60" : "bg-blue-50 dark:bg-blue-950/30"
                }`}
              >
                <div className="font-medium">{n.title}</div>
                <div className="mt-0.5 text-xs text-zinc-600 dark:text-zinc-400">{n.body}</div>
                <div className="mt-1.5 flex items-center gap-3">
                  {n.jobId !== null && (
                    <Link
                      href={`/jobs/${n.jobId}`}
                      onClick={() => !n.readAt && markRead(n.id)}
                      className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
                    >
                      View Job
                    </Link>
                  )}
                  {!n.readAt && (
                    <button
                      type="button"
                      onClick={() => markRead(n.id)}
                      className="text-xs text-zinc-500 hover:underline dark:text-zinc-400"
                    >
                      Mark read
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
