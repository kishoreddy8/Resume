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
  "greenhouse", "ashby", "lever", "workday", "smartrecruiters", "adp_wfn", "adp_rm", "eightfold", "cornerstone", "avature", "paylocity", "icims", "ukg_pro", "bamboohr", "oracle_recruiting_cloud", "workable", "rippling", "paycom", "jazzhr", "jobvite", "breezy", "teamtailor", "applicantpro", "pinpoint", "clearcompany", "personio", "applicantstack", "comeet", "cats", "gohire", "newton", "silkroad", "jobdiva", "taleo", "successfactors", "career_link",
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

  const activeCount = (Object.keys(DEFAULT_FILTERS) as (keyof JobFilterState)[]).filter((k) => {
    const cur = filters[k];
    const def = DEFAULT_FILTERS[k];
    return Array.isArray(cur) ? cur.length !== (def as unknown[]).length : cur !== def;
  }).length;

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

  const sel =
    "w-full rounded-[7px] bg-[var(--z0-bg)] px-2 py-1.5 text-[12px] text-primary shadow-[inset_0_1px_2px_var(--edge-lo)] outline-none transition-shadow duration-150 ease-out focus:shadow-[inset_0_1px_2px_var(--edge-lo),0_0_0_2px_var(--accent-soft)]";
  const chip = (on: boolean) =>
    `rounded-[7px] px-2 py-1 text-[11px] font-medium transition-[background-color,color,box-shadow] duration-150 ease-out active:scale-[0.97] ${
      on
        ? "bg-[var(--accent)] text-[var(--accent-fg)] shadow-[var(--lift-1)]"
        : "bg-[var(--z0-bg)] text-secondary shadow-[inset_0_1px_2px_var(--edge-lo)] hover:text-primary"
    }`;

  return (
    <div className="text-[12px]">
      {/* MATCH — where the job sits in the user's own pipeline. */}
      <Group title="Match">
        <Row label="Pipeline status">
          <select value={filters.status} onChange={(e) => update("status", e.target.value as PipelineStatus | "")} className={sel}>
            <option value="">All</option>
            {STATUSES.map((s) => (<option key={s} value={s}>{s}</option>))}
          </select>
        </Row>
        <Toggle checked={filters.activeOnly} onChange={(v) => update("activeOnly", v)} label="Active postings only" />
      </Group>

      {/* JOB — properties of the posting itself. */}
      <Group title="Job">
        <Row label="Work arrangement">
          <select value={filters.workplaceType} onChange={(e) => update("workplaceType", e.target.value as WorkplaceTypeNormalized | "")} className={sel}>
            <option value="">All</option>
            {WORKPLACE_TYPES.map((w) => (<option key={w} value={w}>{w}</option>))}
          </select>
        </Row>
        <Row label="Employment type">
          <select value={filters.employmentType} onChange={(e) => update("employmentType", e.target.value as EmploymentTypeNormalized | "")} className={sel}>
            <option value="">All</option>
            {EMPLOYMENT_TYPES.map((t) => (<option key={t} value={t}>{t}</option>))}
          </select>
        </Row>
        <Row label="Seniority">
          <select value={filters.seniority} onChange={(e) => update("seniority", e.target.value as Seniority | "")} className={sel}>
            <option value="">All</option>
            {SENIORITY_LEVELS.map((s) => (<option key={s} value={s}>{s}</option>))}
          </select>
        </Row>
        <div className="flex flex-wrap gap-x-4 gap-y-1.5 pt-0.5">
          <Toggle checked={filters.salaryAvailable} onChange={(v) => update("salaryAvailable", v)} label="Salary available" />
          <Toggle checked={filters.clearanceRequired} onChange={(v) => update("clearanceRequired", v)} label="Clearance required" />
        </div>
      </Group>

      {/* SPONSORSHIP — presets first, then the individual levels they compose. */}
      <Group title="Sponsorship">
        <Toggle checked={filters.hideNotSponsoring} onChange={(v) => update("hideNotSponsoring", v)} label={'Hide "Not Sponsoring"'} />
        <div className="flex flex-wrap gap-1.5 pt-1">
          {H1B_PRESETS.map((preset) => (
            <button key={preset.label} type="button" onClick={() => applyPreset(preset.values)} className={chip(sameValues(preset.values, filters.h1bConfidence))}>
              {preset.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {H1B_CONFIDENCE_LEVELS.map((level) => (
            <button key={level} type="button" onClick={() => toggleH1bConfidence(level)} className={chip(filters.h1bConfidence.includes(level))}>
              {level}
            </button>
          ))}
        </div>
        <p className="text-[11px] leading-relaxed text-tertiary">
          Selecting none shows all levels. Selecting some shows only those.
        </p>
      </Group>

      {/* SOURCE — where the posting came from. */}
      <Group title="Source" last>
        <Row label="Company">
          <select value={filters.companyId} onChange={(e) => update("companyId", e.target.value ? Number(e.target.value) : "")} className={sel}>
            <option value="">All</option>
            {companies.map((c) => (<option key={c.id} value={c.id}>{c.name}</option>))}
          </select>
        </Row>
        <Row label="ATS source">
          <select value={filters.sourceType} onChange={(e) => update("sourceType", e.target.value as SourceType | "")} className={sel}>
            <option value="">All</option>
            {SOURCES.map((s) => (<option key={s} value={s}>{s}</option>))}
          </select>
        </Row>
      </Group>

      <div className="flex items-center justify-between border-t border-[var(--separator)] px-3.5 py-2.5">
        <span className="text-[11px] text-tertiary">
          {activeCount === 0 ? "No filters active" : `${activeCount} filter${activeCount === 1 ? "" : "s"} active`}
        </span>
        <button
          type="button"
          onClick={() => onChange(DEFAULT_FILTERS)}
          disabled={activeCount === 0}
          className="rounded-[7px] px-2 py-1 text-[11px] font-medium text-secondary transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] hover:text-primary active:scale-[0.97] disabled:opacity-40"
        >
          Clear all
        </button>
      </div>
    </div>
  );
}

/** A titled band. Sections are separated by hairlines, not boxes — the panel is one plane. */
function Group({ title, children, last }: { title: string; children: React.ReactNode; last?: boolean }) {
  return (
    <div className={last ? "px-3.5 py-3" : "border-b border-[var(--separator)] px-3.5 py-3"}>
      <h3 className="mb-2 flex items-center gap-2 text-[9px] font-semibold uppercase tracking-[0.13em] text-tertiary">
        <span aria-hidden="true" className="h-px w-2.5 bg-[var(--border)]" />
        {title}
      </h3>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

/** Label left, control right — a compact row instead of a stacked label/field pair. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid grid-cols-[8.5rem_1fr] items-center gap-2">
      <span className="text-[11.5px] text-secondary">{label}</span>
      {children}
    </label>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-[11.5px] text-secondary">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-3.5 w-3.5 accent-[var(--accent)]" />
      {label}
    </label>
  );
}
