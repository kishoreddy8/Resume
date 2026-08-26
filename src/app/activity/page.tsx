"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useResolvedCandidateId } from "@/lib/useActiveCandidateId";
import { BTN_SECONDARY, EmptyState, LoadingRegion, PageHeader, Panel, PanelEmpty, SkeletonRows } from "@/components/ui";
import { IconInbox } from "@/components/icons";
import type { NotificationResponseEntry } from "@/app/api/candidates/[candidateId]/notifications/route";

/**
 * UI-M — the minimal, truthful Activity destination the mobile bottom nav's fifth tab needs.
 *
 * User-authorized scope, exact: reuse the EXISTING notifications API and data only (the same
 * `/api/candidates/[id]/notifications` + mark-read/mark-all-read endpoints `NotificationBell`
 * already calls) — no new notification type, no application-progress or resume-tailoring
 * aggregation, no backend change. This is a full-page rendering of data that already exists and is
 * already fetched elsewhere; it is explicitly NOT the final Activity redesign — a future phase
 * enriches this once those other event sources are intentionally integrated.
 */
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

export default function ActivityPage() {
  const candidateId = useResolvedCandidateId();
  const [notifications, setNotifications] = useState<NotificationResponseEntry[] | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    if (candidateId === null) return;
    setError(false);
    try {
      const res = await fetch(`/api/candidates/${candidateId}/notifications?limit=50`);
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json();
      setNotifications(body.notifications ?? []);
      setUnreadCount(body.unreadCount ?? 0);
    } catch {
      setError(true);
    }
  }, [candidateId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  async function markRead(notificationId: number) {
    if (candidateId === null) return;
    setNotifications((prev) => prev?.map((n) => (n.id === notificationId ? { ...n, readAt: new Date().toISOString() } : n)) ?? prev);
    setUnreadCount((prev) => Math.max(0, prev - 1));
    await fetch(`/api/candidates/${candidateId}/notifications/${notificationId}`, { method: "PATCH" });
  }

  async function markAllRead() {
    if (candidateId === null) return;
    setNotifications((prev) => prev?.map((n) => (n.readAt ? n : { ...n, readAt: new Date().toISOString() })) ?? prev);
    setUnreadCount(0);
    await fetch(`/api/candidates/${candidateId}/notifications/mark-all-read`, { method: "POST" });
  }

  if (error) {
    return (
      <div className="mx-auto flex w-full max-w-[var(--candidate-page-max)] flex-col gap-6">
        <PageHeader size="lg" title="Activity" />
        <Panel>
          <PanelEmpty action={<button type="button" onClick={load} className={`${BTN_SECONDARY} min-h-11`}>Retry</button>}>
            We couldn&apos;t load your activity.
          </PanelEmpty>
        </Panel>
      </div>
    );
  }

  if (candidateId === null || notifications === null) {
    return (
      <div className="mx-auto flex w-full max-w-[var(--candidate-page-max)] flex-col gap-5">
        <PageHeader size="lg" title="Activity" description="What Career-Ops has found and done for you." />
        <LoadingRegion label="Loading activity" />
        <Panel>
          <SkeletonRows rows={5} />
        </Panel>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-[var(--candidate-page-max)] flex-col gap-6 pb-12">
      <PageHeader
        size="lg"
        title="Activity"
        description="What Career-Ops has found and done for you."
        actions={
          unreadCount > 0 ? (
            <button type="button" onClick={markAllRead} className={`${BTN_SECONDARY} min-h-11`}>
              Mark all read
            </button>
          ) : undefined
        }
      />

      {notifications.length === 0 ? (
        <Panel>
          <EmptyState
            icon={<IconInbox size={22} />}
            title="No activity yet"
            description="A scan that turns up new matches for you will post here."
          />
        </Panel>
      ) : (
        <Panel>
          <ul className="-mx-5 -my-5 divide-y divide-[var(--separator)] sm:-mx-6 sm:-my-6">
            {notifications.map((n) => (
              <li key={n.id} className={`relative py-3.5 pl-5 pr-4 ${n.readAt ? "opacity-70" : ""}`}>
                {!n.readAt && (
                  <span aria-hidden="true" className="absolute inset-y-2 left-0 w-[2px] rounded-r-full bg-[var(--accent)]" />
                )}
                <div className="flex items-baseline gap-2">
                  <span className={`min-w-0 flex-1 truncate text-[14px] ${n.readAt ? "font-medium text-secondary" : "font-semibold text-primary"}`}>
                    {n.title}
                  </span>
                  <span className="shrink-0 text-[12px] tabular-nums text-tertiary">{ago(n.createdAt)}</span>
                </div>
                <p className="mt-1 text-[13px] leading-relaxed text-tertiary">{n.body}</p>
                <div className="mt-2 flex items-center gap-4">
                  {n.jobId !== null && (
                    <Link
                      href={`/jobs/${n.jobId}`}
                      onClick={() => !n.readAt && markRead(n.id)}
                      className="inline-flex min-h-11 items-center text-[13px] font-medium text-[var(--accent)] hover:opacity-80"
                    >
                      View job
                    </Link>
                  )}
                  {!n.readAt && (
                    <button
                      type="button"
                      onClick={() => markRead(n.id)}
                      className="inline-flex min-h-11 items-center text-[13px] text-tertiary hover:text-secondary"
                    >
                      Mark read
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}
