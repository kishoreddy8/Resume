"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AdminEmptyState,
  AdminErrorState,
  AdminLoadingState,
  AdminPageHeader,
  AdminStatus,
  OperationalTable,
  TechnicalDetails,
} from "@/components/admin";
import { useAdminCandidate } from "@/lib/admin/AdminContext";

type EventItem = {
  category: string;
  id: number;
  event: string;
  detail: string | null;
  occurredAt: string;
};

type ActivityData = {
  events: EventItem[];
  coverage: string;
};

export default function AdminActivityPage() {
  const { candidateId } = useAdminCandidate();
  const [data, setData] = useState<ActivityData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/admin/activity?candidateId=${candidateId}&limit=75`);
      if (!r.ok) {
        throw new Error((await r.json()).error ?? "Activity data unavailable");
      }
      setData(await r.json());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Activity data unavailable");
    }
  }, [candidateId]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  const events = useMemo(
    () => data?.events.filter((e) => !category || e.category === category) ?? [],
    [data, category]
  );

  if (error && !data) {
    return <AdminErrorState detail={error} retry={() => void load()} />;
  }

  if (!data) {
    return <AdminLoadingState label="Loading operational timeline and durable activity log" />;
  }

  const categories = [...new Set(data.events.map((e) => e.category))];

  return (
    <div className="admin-page-stack">
      <AdminPageHeader
        eyebrow="Operational History"
        title="Activity Log"
        description="A bounded operational timeline assembled from persistent durable event records across scanner, scheduler, writer, and application subsystems."
        statusSummary={
          <AdminStatus
            status="healthy"
            label={`${events.length} Events Listed`}
          />
        }
        actions={
          <button
            type="button"
            className="admin-button admin-button-secondary"
            onClick={() => void load()}
          >
            Refresh
          </button>
        }
      />

      {/* Filter Bar */}
      <div className="admin-filter-bar admin-filter-compact">
        <label>
          <span>Filter by Source Subsystem</span>
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">All Subsystems ({data.events.length})</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* Activity Table */}
      {events.length > 0 ? (
        <OperationalTable label="Recent system activity timeline">
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>Subsystem</th>
              <th>Event</th>
              <th>Status</th>
              <th>Event Details</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={`${e.category}-${e.id}`}>
                <td className="text-secondary text-sm whitespace-nowrap">
                  {new Date(e.occurredAt).toLocaleString()}
                </td>
                <td>
                  <span className="font-semibold text-primary">{e.category}</span>
                </td>
                <td className="font-medium">{e.event}</td>
                <td>
                  <AdminStatus
                    status={
                      /fail|error/i.test(e.event)
                        ? "failed"
                        : /running|started|progress/i.test(e.event)
                        ? "running"
                        : /completed|success|ready|approved|resumed/i.test(e.event)
                        ? "completed"
                        : "idle"
                    }
                  />
                </td>
                <td>
                  {e.detail ? (
                    <TechnicalDetails summary="View detail payload">
                      <p>{e.detail}</p>
                    </TechnicalDetails>
                  ) : (
                    <span className="text-tertiary text-xs">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </OperationalTable>
      ) : (
        <AdminEmptyState
          title="No events found"
          detail="No persistent events match the selected subsystem category."
        />
      )}

      <p className="admin-updated-at">
        Durable Event Coverage: <span className="font-medium text-secondary">{data.coverage}</span>
      </p>
    </div>
  );
}
