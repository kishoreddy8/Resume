"use client";

import type {
  Company,
  EmploymentTypeNormalized,
  H1bJobConfidence,
  PipelineStatus,
  Seniority,
  SourceType,
  WorkplaceTypeNormalized,
} from "@/types";

export interface JobFilterState {
  status: PipelineStatus | "";
  companyId: number | "";
  sourceType: SourceType | "";
  search: string;
  activeOnly: boolean;
  hideNotSponsoring: boolean;
  h1bConfidence: H1bJobConfidence[];
  // --- Structured Job Intelligence filters (additive; see src/lib/jobIntel/) -------------------
  workplaceType: WorkplaceTypeNormalized | "";
  employmentType: EmploymentTypeNormalized | "";
  seniority: Seniority | "";
  salaryAvailable: boolean;
  clearanceRequired: boolean;
}

export const DEFAULT_FILTERS: JobFilterState = {
  status: "",
  companyId: "",
  sourceType: "",
  search: "",
  activeOnly: true,
  hideNotSponsoring: false,
  h1bConfidence: [],
  workplaceType: "",
  employmentType: "",
  seniority: "",
  salaryAvailable: false,
  clearanceRequired: false,
};

const STATUSES: PipelineStatus[] = [
  "New",
  "Interested",
  "Applied",
  "Interviewing",
  "Offer",
  "Employer Rejected",
];
const SOURCES: SourceType[] = [
  "greenhouse", "ashby", "lever", "workday", "smartrecruiters", "adp_wfn", "adp_rm", "eightfold", "cornerstone", "avature", "paylocity", "icims", "ukg_pro", "bamboohr", "oracle_recruiting_cloud", "workable", "rippling", "paycom", "jazzhr", "jobvite", "breezy", "teamtailor", "applicantpro", "pinpoint", "clearcompany", "personio", "applicantstack", "comeet", "cats", "gohire", "newton", "silkroad", "jobdiva", "taleo", "career_link",
];
const H1B_CONFIDENCE_LEVELS: H1bJobConfidence[] = [
  "Very High",
  "High",
  "Medium",
  "Low",
  "Unknown",
  "Not Sponsoring",
];
const WORKPLACE_TYPES: WorkplaceTypeNormalized[] = ["Remote", "Hybrid", "Onsite"];
const EMPLOYMENT_TYPES: EmploymentTypeNormalized[] = [
  "Full-Time",
  "Part-Time",
  "Contract",
  "Temporary",
  "Internship",
  "Contract-to-Hire",
];
const SENIORITY_LEVELS: Seniority[] = [
  "Intern",
  "Entry",
  "Junior",
  "Mid",
  "Senior",
  "Staff",
  "Principal",
  "Lead",
  "Manager",
  "Director",
];

// Named quick-filter presets: one click sets the exact chip combination each label implies. Power
// users can still fine-tune individual chips afterward — presets and raw chips share the same
// underlying h1bConfidence selection, they're just two ways to set it.
const H1B_PRESETS: { label: string; values: H1bJobConfidence[] }[] = [
  { label: "Likely Sponsor", values: ["Very High", "High", "Medium"] },
  { label: "High Confidence", values: ["Very High", "High"] },
  { label: "Unknown", values: ["Unknown"] },
  { label: "Not Sponsoring", values: ["Not Sponsoring"] },
];

function sameValues(a: H1bJobConfidence[], b: H1bJobConfidence[]): boolean {
  return a.length === b.length && a.every((v) => b.includes(v));
}

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

  function toggleH1bConfidence(level: H1bJobConfidence) {
    const set = new Set(filters.h1bConfidence);
    if (set.has(level)) set.delete(level);
    else set.add(level);
    update("h1bConfidence", Array.from(set));
  }

  function applyPreset(values: H1bJobConfidence[]) {
    // Clicking an already-active preset clears it back to "show everything", same toggle
    // ergonomics as the individual chips below.
    update("h1bConfidence", sameValues(values, filters.h1bConfidence) ? [] : values);
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
        <label className="mb-1 block font-medium text-zinc-700 dark:text-zinc-300">
          Work arrangement
        </label>
        <select
          value={filters.workplaceType}
          onChange={(e) => update("workplaceType", e.target.value as WorkplaceTypeNormalized | "")}
          className="w-full rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
        >
          <option value="">All</option>
          {WORKPLACE_TYPES.map((w) => (
            <option key={w} value={w}>
              {w}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="mb-1 block font-medium text-zinc-700 dark:text-zinc-300">
          Employment type
        </label>
        <select
          value={filters.employmentType}
          onChange={(e) => update("employmentType", e.target.value as EmploymentTypeNormalized | "")}
          className="w-full rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
        >
          <option value="">All</option>
          {EMPLOYMENT_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="mb-1 block font-medium text-zinc-700 dark:text-zinc-300">Seniority</label>
        <select
          value={filters.seniority}
          onChange={(e) => update("seniority", e.target.value as Seniority | "")}
          className="w-full rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
        >
          <option value="">All</option>
          {SENIORITY_LEVELS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      <label className="flex items-center gap-2 text-zinc-600 dark:text-zinc-400">
        <input
          type="checkbox"
          checked={filters.salaryAvailable}
          onChange={(e) => update("salaryAvailable", e.target.checked)}
        />
        Salary available
      </label>

      <label className="flex items-center gap-2 text-zinc-600 dark:text-zinc-400">
        <input
          type="checkbox"
          checked={filters.clearanceRequired}
          onChange={(e) => update("clearanceRequired", e.target.checked)}
        />
        Clearance required
      </label>

      <div>
        <label className="mb-1 flex items-center justify-between font-medium text-zinc-700 dark:text-zinc-300">
          Sponsorship state
        </label>
        <label className="mb-2 flex items-center gap-2 text-zinc-600 dark:text-zinc-400">
          <input
            type="checkbox"
            checked={filters.hideNotSponsoring}
            onChange={(e) => update("hideNotSponsoring", e.target.checked)}
          />
          Hide &quot;Not Sponsoring&quot;
        </label>
        <div className="mb-2 flex flex-wrap gap-1.5">
          {H1B_PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              onClick={() => applyPreset(preset.values)}
              className={`rounded border px-2 py-0.5 text-xs ${
                sameValues(preset.values, filters.h1bConfidence)
                  ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                  : "border-zinc-300 text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
              }`}
            >
              {preset.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {H1B_CONFIDENCE_LEVELS.map((level) => (
            <button
              key={level}
              type="button"
              onClick={() => toggleH1bConfidence(level)}
              className={`rounded-full border px-2 py-0.5 text-xs ${
                filters.h1bConfidence.includes(level)
                  ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                  : "border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400"
              }`}
            >
              {level}
            </button>
          ))}
        </div>
        <p className="mt-1 text-xs text-zinc-500">
          Selecting none shows all levels. Selecting some shows only those.
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
