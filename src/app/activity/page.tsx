"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useResolvedCandidateId } from "@/lib/useActiveCandidateId";
import { BTN_SECONDARY, EmptyState, ErrorState, LoadingRegion, PageHeader, Panel, SkeletonRows } from "@/components/ui";
import { IconCheckCircle, IconDocument, IconInbox, IconStar } from "@/components/icons";
import type { NotificationResponseEntry } from "@/app/api/candidates/[candidateId]/notifications/route";
import {
  ACTIVITY_GROUP_LABEL,
  groupForTimestamp,
  matchesFilter,
  presentActivityItem,
  type ActivityFilter,
  type ActivityGroup,
  type ActivityPresentation,
  type ActivityTone,
} from "./activityPresentation";

/**
 * UI-ACT — the candidate Activity feed: what Career-Ops has done, what changed, and what is
 * waiting on you.
 *
 * SAME SOURCE AS UI-M, NO NEW BACKEND. Still exactly the two existing endpoints NotificationBell
 * already calls (list + unreadCount in one response, PATCH one/POST mark-all-read) — no new route,
 * no new persistence, no notification-generation change. Every classification below (domain, tone,
 * "needs you", destination) is read from real, existing structured facts already on the wire — the
 * notification's own `type`, and its `dedupeKey`'s documented format — never guessed from title or
 * body prose. See ./activityPresentation.ts for the full reasoning and the one place that logic
 * lives, so it stays testable independent of this render.
 *
 * BOUNDED, NOT PAGINATED. The underlying API takes a flat `limit` with no cursor/offset — there is
 * no safe way to build a real "Load more" without a backend change this phase does not make. A
 * bounded fetch (100, the API's own cap is 200) with an honest note when the feed is exactly at that
 * bound is the truthful choice over inventing pagination over data that was never fetched.
 */

const LIMIT = 100;

const FILTERS: { id: ActivityFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "needsYou", label: "Needs You" },
  { id: "job", label: "Jobs" },
  { id: "resume", label: "Resumes" },
  { id: "application", label: "Applications" },
];

const GROUP_ORDER: ActivityGroup[] = ["today", "yesterday", "earlier"];

const TONE_ICON: Record<ActivityTone, { icon: (p: { size: number }) => React.ReactNode; bg: string; fg: string }> = {
  opportunity: { icon: (p) => <IconStar size={p.size} />, bg: "bg-[var(--tile-lav-bg)]", fg: "text-[var(--tile-lav-fg)]" },
  success: { icon: (p) => <IconCheckCircle size={p.size} />, bg: "bg-[var(--tile-green-bg)]", fg: "text-[var(--tile-green-fg)]" },
  attention: { icon: (p) => <IconInbox size={p.size} />, bg: "bg-[var(--tile-amber-bg)]", fg: "text-[var(--tile-amber-fg)]" },
  neutral: { icon: (p) => <IconDocument size={p.size} />, bg: "bg-[var(--z0-bg)]", fg: "text-tertiary" },
};

/** Absolute-since formatter — deterministic at render time, no periodic re-render to keep it "live"
 *  (Part 10: a static relative timestamp is acceptable; a fake ticking clock is not). */
function ago(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

interface ActivityItem extends NotificationResponseEntry {
  presentation: ActivityPresentation;
}

function Row({ item, onMarkRead }: { item: ActivityItem; onMarkRead: (id: number) => void }) {
  const { presentation } = item;
  const tone = TONE_ICON[presentation.tone];
  const unread = item.readAt === null;
  return (
    <li className="relative flex gap-3 py-3.5 pl-4 pr-1 first:pt-0 last:pb-0">
      {unread && (
        <span aria-hidden="true" className="absolute inset-y-2 left-0 w-[2px] rounded-r-full bg-[var(--accent)]" />
      )}
      <span aria-hidden="true" className={`grid h-9 w-9 shrink-0 place-items-center rounded-[10px] ${tone.bg} ${tone.fg}`}>
        {tone.icon({ size: 16 })}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className={`min-w-0 text-[14px] ${unread ? "font-semibold text-primary" : "font-medium text-secondary"}`}>
            {/* UI-ACT.1: the accent bar above is aria-hidden and the bold weight is CSS-only — with
             *  neither, a screen reader had no way to tell this item apart from a read one. */}
            {unread && <span className="sr-only">Unread: </span>}
            {item.title}
          </span>
          {presentation.statusLabel && (
            <span className="shrink-0 rounded-full bg-[var(--z0-bg)] px-2 py-0.5 text-[12px] font-medium text-tertiary">
              {presentation.statusLabel}
            </span>
          )}
          <span className="ml-auto shrink-0 text-[12px] tabular-nums text-tertiary">{ago(item.createdAt)}</span>
        </div>
        <p className="mt-0.5 text-[13px] leading-relaxed text-tertiary">{item.body}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1">
          {presentation.href && (
            <Link
              href={presentation.href}
              onClick={() => unread && onMarkRead(item.id)}
              className="inline-flex min-h-11 items-center text-[13px] font-semibold text-[var(--accent)] hover:opacity-80"
            >
              {presentation.ctaLabel}
            </Link>
          )}
          {unread && (
            <button
              type="button"
              onClick={() => onMarkRead(item.id)}
              className="inline-flex min-h-11 items-center text-[13px] text-tertiary hover:text-secondary"
            >
              Mark read
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

export default function ActivityPage() {
  const candidateId = useResolvedCandidateId();
  const [notifications, setNotifications] = useState<NotificationResponseEntry[] | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [error, setError] = useState(false);
  const [filter, setFilter] = useState<ActivityFilter>("all");

  const load = useCallback(async () => {
    if (candidateId === null) return;
    setError(false);
    try {
      const res = await fetch(`/api/candidates/${candidateId}/notifications?limit=${LIMIT}`);
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
    void load();
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

  const items = useMemo<ActivityItem[]>(
    () => (notifications ?? []).map((n) => ({ ...n, presentation: presentActivityItem(n.type, n.dedupeKey, n.jobId) })),
    [notifications]
  );
  const needsYou = useMemo(() => items.filter((i) => i.presentation.needsUser), [items]);
  const domains = useMemo(() => new Set(items.map((i) => i.presentation.domain)), [items]);
  const showFilters = domains.size > 1;
  const filtered = useMemo(() => items.filter((i) => matchesFilter(i.presentation, filter)), [items, filter]);
  const grouped = useMemo(() => {
    const buckets: Record<ActivityGroup, ActivityItem[]> = { today: [], yesterday: [], earlier: [] };
    for (const item of filtered) buckets[groupForTimestamp(item.createdAt)].push(item);
    return buckets;
  }, [filtered]);

  if (error) {
    return (
      <div className="mx-auto flex w-full max-w-[var(--candidate-page-max)] flex-col gap-6">
        <PageHeader size="lg" title="Activity" />
        <ErrorState
          title="Your activity couldn't load"
          whatHappened="Career-Ops couldn't reach your recent activity just now."
          whatIsSafe="Nothing about your jobs, applications or resumes was changed."
          onRetry={() => void load()}
        />
      </div>
    );
  }

  if (candidateId === null || notifications === null) {
    return (
      <div className="mx-auto flex w-full max-w-[var(--candidate-page-max)] flex-col gap-5">
        <PageHeader size="lg" title="Activity" description="Recent Career-Ops activity and items that may need you." />
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
        description="Recent Career-Ops activity and items that may need you."
        actions={
          unreadCount > 0 ? (
            <button type="button" onClick={markAllRead} className={`${BTN_SECONDARY} min-h-11 text-[14px]`}>
              Mark all read
            </button>
          ) : undefined
        }
      />

      {items.length === 0 ? (
        <Panel>
          <EmptyState
            icon={<IconInbox size={22} />}
            title="No activity yet"
            description="Career-Ops activity will appear here as jobs, resumes, and applications move forward."
          />
        </Panel>
      ) : (
        <>
          {needsYou.length > 0 && (
            <section aria-labelledby="activity-needs-you-title" className="rounded-[18px] border border-[var(--border)] bg-[var(--z3-bg)] p-5 shadow-[var(--shadow-card)]">
              <p id="activity-needs-you-title" className="text-[13px] font-semibold uppercase tracking-[0.075em] text-[var(--pill-amber-fg)]">
                Needs you
              </p>
              <ul className="mt-2 divide-y divide-[var(--separator)]">
                {needsYou.slice(0, 5).map((item) => (
                  <Row key={item.id} item={item} onMarkRead={markRead} />
                ))}
              </ul>
            </section>
          )}

          {showFilters && (
            /* UI-ACT.1: plain buttons + aria-pressed, not the ARIA tab pattern — these are content
             *  filters, not tabpanels, and this row implements none of the tab pattern's required
             *  keyboard behavior (arrow-key roving focus, Home/End, aria-controls to a panel). Using
             *  role="tablist"/role="tab" without that behavior promises assistive tech a keyboard
             *  interaction that doesn't exist. Matches the same plain-button + state-attribute
             *  precedent Settings' own category rail already uses (aria-current there; aria-pressed
             *  here, since this is a toggle-style filter rather than a page identity). */
            <div role="group" aria-label="Filter activity" className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  aria-pressed={filter === f.id}
                  onClick={() => setFilter(f.id)}
                  className={`min-h-11 shrink-0 rounded-full border px-4 text-[13px] font-semibold transition-colors ${
                    filter === f.id
                      ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]"
                      : "border-[var(--border-control)] text-secondary hover:bg-[var(--surface-hover)]"
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          )}

          <Panel>
            {filtered.length === 0 ? (
              <EmptyState title="Nothing here" description="No activity matches this filter yet." />
            ) : (
              <div className="flex flex-col gap-5">
                {GROUP_ORDER.filter((g) => grouped[g].length > 0).map((group) => (
                  <div key={group}>
                    <p className="mb-2 text-[13px] font-semibold uppercase tracking-[0.065em] text-tertiary">
                      {ACTIVITY_GROUP_LABEL[group]}
                    </p>
                    <ul className="divide-y divide-[var(--separator)]">
                      {grouped[group].map((item) => (
                        <Row key={item.id} item={item} onMarkRead={markRead} />
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          {notifications.length >= LIMIT && (
            <p className="text-center text-[13px] text-tertiary">
              Showing your most recent {LIMIT} activity items.
            </p>
          )}
        </>
      )}
    </div>
  );
}
