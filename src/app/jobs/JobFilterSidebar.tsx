"use client";

import type { Company, H1bCombinedSignal, PipelineStatus, SourceType } from "@/types";

export interface JobFilterState {
  status: PipelineStatus | "";
  companyId: number | "";
  sourceType: SourceType | "";
  search: string;
  activeOnly: boolean;
  hideUnlikely: boolean;
  h1bSignal: H1bCombinedSignal[];
}

export const DEFAULT_FILTERS: JobFilterState = {
  status: "",
  companyId: "",
  sourceType: "",
  search: "",
  activeOnly: true,
  hideUnlikely: false,
  h1bSignal: [],
};

const STATUSES: PipelineStatus[] = [
  "New",
  "Interested",
  "Applied",
  "Interviewing",
  "Offer",
  "Employer Rejected",
];
const SOURCES: SourceType[] = ["greenhouse", "ashby", "lever", "workday", "career_link"];
const H1B_SIGNALS: H1bCombinedSignal[] = ["Likely", "High", "Medium", "Low", "Unknown", "Unlikely"];

export function JobFilterSidebar({
  filters,
  onChange,
  companies,
}: {
  filters: JobFilterState;
  onChange: (filters: JobFilterState) => void;
  companies: Company[];
}) {
  function update<K extends keyof JobFilterState>(key: K, value: JobFilterState[K]) {
    onChange({ ...filters, [key]: value });
  }

  function toggleH1bSignal(signal: H1bCombinedSignal) {
    const set = new Set(filters.h1bSignal);
    if (set.has(signal)) set.delete(signal);
    else set.add(signal);
    update("h1bSignal", Array.from(set));
  }

  return (
    <aside className="w-full shrink-0 space-y-5 rounded-lg border border-zinc-200 bg-white p-4 text-sm dark:border-zinc-800 dark:bg-zinc-900 lg:w-64">
      <div>
        <label className="mb-1 block font-medium text-zinc-700 dark:text-zinc-300">Search</label>
        <input
          type="text"
          value={filters.search}
          onChange={(e) => update("search", e.target.value)}
          placeholder="Title, company, description…"
          className="w-full rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
        />
      </div>

      <div>
        <label className="mb-1 block font-medium text-zinc-700 dark:text-zinc-300">
          Pipeline status
        </label>
        <select
          value={filters.status}
          onChange={(e) => update("status", e.target.value as PipelineStatus | "")}
          className="w-full rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
        >
          <option value="">All</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="mb-1 block font-medium text-zinc-700 dark:text-zinc-300">Company</label>
        <select
          value={filters.companyId}
          onChange={(e) => update("companyId", e.target.value ? Number(e.target.value) : "")}
          className="w-full rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
        >
          <option value="">All</option>
          {companies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="mb-1 block font-medium text-zinc-700 dark:text-zinc-300">Source</label>
        <select
          value={filters.sourceType}
          onChange={(e) => update("sourceType", e.target.value as SourceType | "")}
          className="w-full rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
        >
          <option value="">All</option>
          {SOURCES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="mb-1 flex items-center justify-between font-medium text-zinc-700 dark:text-zinc-300">
          H1B sponsorship
        </label>
        <label className="mb-2 flex items-center gap-2 text-zinc-600 dark:text-zinc-400">
          <input
            type="checkbox"
            checked={filters.hideUnlikely}
            onChange={(e) => update("hideUnlikely", e.target.checked)}
          />
          Hide &quot;Unlikely&quot; sponsors
        </label>
        <div className="flex flex-wrap gap-1.5">
          {H1B_SIGNALS.map((signal) => (
            <button
              key={signal}
              type="button"
              onClick={() => toggleH1bSignal(signal)}
              className={`rounded-full border px-2 py-0.5 text-xs ${
                filters.h1bSignal.includes(signal)
                  ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                  : "border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400"
              }`}
            >
              {signal}
            </button>
          ))}
        </div>
        <p className="mt-1 text-xs text-zinc-500">
          Selecting none shows all signals. Selecting some shows only those.
        </p>
      </div>

      <label className="flex items-center gap-2 text-zinc-600 dark:text-zinc-400">
        <input
          type="checkbox"
          checked={filters.activeOnly}
          onChange={(e) => update("activeOnly", e.target.checked)}
        />
        Active postings only
      </label>

      <button
        type="button"
        onClick={() => onChange(DEFAULT_FILTERS)}
        className="text-xs text-zinc-500 underline hover:text-zinc-800 dark:hover:text-zinc-200"
      >
        Reset filters
      </button>
    </aside>
  );
}
