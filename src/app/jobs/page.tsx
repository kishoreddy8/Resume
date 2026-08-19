"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useActiveCandidateId } from "@/lib/useActiveCandidateId";
import type { Company, JobWithCompany, ScanSummary } from "@/types";
import { DEFAULT_FILTERS, JobFilterSidebar, type JobFilterState } from "./JobFilterSidebar";
import { ForYouList } from "./ForYouList";
import { JobList } from "./JobList";
import { Workbench } from "./Workbench";
import { motion, useReducedMotion } from "motion/react";
import { AppToolbarSlot } from "@/components/AppToolbarSlot";
import { useLifecycleThresholds } from "./useLifecycleThresholds";

type JobsView = "forYou" | "all";

/** The filter panel only collapses where it is a side column; below that it stacks and must keep
 *  its natural width, so no animated pixel width is applied. */
function useDesktopFilters() {
  const [desktop, setDesktop] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const apply = () => setDesktop(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  return desktop;
}

function buildQuery(filters: JobFilterState): string {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.companyId) params.set("companyId", String(filters.companyId));
  if (filters.sourceType) params.set("sourceType", filters.sourceType);
  if (filters.search) params.set("search", filters.search);
  if (filters.activeOnly) params.set("activeOnly", "true");
  if (filters.workplaceType) params.set("workplaceType", filters.workplaceType);
  if (filters.employmentType) params.set("employmentType", filters.employmentType);
  if (filters.seniority) params.set("seniority", filters.seniority);
  if (filters.salaryAvailable) params.set("salaryAvailable", "true");
  if (filters.clearanceRequired) params.set("clearanceRequired", "true");

  const levels = filters.hideNotSponsoring
    ? filters.h1bConfidence.filter((s) => s !== "Not Sponsoring")
    : filters.h1bConfidence;
  if (filters.hideNotSponsoring && filters.h1bConfidence.length === 0) {
    for (const s of ["Very High", "High", "Medium", "Low", "Unknown"]) params.append("h1bConfidence", s);
  } else {
    for (const s of levels) params.append("h1bConfidence", s);
  }

  return params.toString();
}

export default function JobsPage() {
  const candidateId = useActiveCandidateId();
  const [view, setView] = useState<JobsView>("forYou");
  const [filters, setFilters] = useState<JobFilterState>(DEFAULT_FILTERS);
  const [jobs, setJobs] = useState<JobWithCompany[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<ScanSummary | null>(null);
  // Selected job for the Workbench master/detail pair. Deep-linkable via ?job=<id> so the URL
  // reflects the current state, and intentionally NOT persisted anywhere else.
  const [selectedJobId, setSelectedJobId] = useState<number | null>(null);
  // Filters collapse so the list + review pair can use the full workspace. Collapsed means
  // *reshaped, not hidden*: the toggle stays visible and labelled, and the panel is one click away.
  const [filtersOpen, setFiltersOpen] = useState(true);
  /**
   * Search moved out of the collapsible filter panel and into the toolbar, so it stays reachable
   * when filters are closed. It is also debounced now: it previously committed on every keystroke,
   * and each commit re-ran the whole /api/jobs query — typing "data engineer" fired 13 full
   * requests over 16,005 jobs. The query itself is untouched; only how often it is asked changed.
   */
  const [searchDraft, setSearchDraft] = useState("");
  const committedSearch = useRef("");
  const reduced = useReducedMotion() ?? false;
  const desktopFilters = useDesktopFilters();
  const { thresholds, loaded: thresholdsLoaded } = useLifecycleThresholds();

  useEffect(() => {
    if (searchDraft === committedSearch.current) return;
    const t = setTimeout(() => {
      committedSearch.current = searchDraft;
      setFilters((f) => ({ ...f, search: searchDraft }));
    }, 250);
    return () => clearTimeout(t);
  }, [searchDraft]);

  // Keeps the box in step when something else changes the filter — "Reset filters", for instance.
  useEffect(() => {
    if (filters.search === committedSearch.current) return;
    committedSearch.current = filters.search;
    setSearchDraft(filters.search);
  }, [filters.search]);

  const query = useMemo(() => `${buildQuery(filters)}&candidateId=${candidateId}`, [filters, candidateId]);

  const loadJobs = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/jobs?${query}`);
      const data = await res.json();
      setJobs(data.jobs ?? []);
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    fetch("/api/companies")
      .then((r) => r.json())
      .then((d) => setCompanies(d.companies ?? []));
  }, []);

  useEffect(() => {
    // Only the "All Jobs" view needs the unranked/filtered listJobs fetch — For You loads its own
    // ranked data independently (see ForYouList). Avoids a wasted request on the default view.
    if (view !== "all") return;
    // Intentional: fetch-on-mount/filter-change with a loading flag, not a render loop.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadJobs();
  }, [loadJobs, view]);

  async function runScan() {
    setScanning(true);
    setScanResult(null);
    try {
      const res = await fetch("/api/scan", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const summary = (await res.json()) as ScanSummary;
      setScanResult(summary);
      if (view === "all") await loadJobs();
    } finally {
      setScanning(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Title and the page's primary action live in the application toolbar, which used to hold
       *  only the notification bell. Merging the two bands removes a whole row of chrome and hands
       *  that height back to the jobs list. */}
      <AppToolbarSlot>
        <h1 className="shrink-0 text-[15px] font-semibold tracking-tight text-primary">Jobs</h1>
        <label className="min-w-0 flex-1 md:max-w-sm">
          <span className="sr-only">Search jobs by title, company or description</span>
          <input
            type="search"
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            placeholder="Search title, company, description…"
            className="w-full rounded-md border border-[var(--border)] bg-surface px-2.5 py-1 text-[13px] text-primary transition-colors duration-150 ease-out placeholder:text-tertiary hover:bg-[var(--surface-hover)] focus:bg-surface"
          />
        </label>
        {scanResult && (
          <span className="hidden min-w-0 truncate text-[11px] tabular-nums text-tertiary xl:block">
            +{scanResult.jobsNew} new · {scanResult.jobsUpdated} updated ·{" "}
            {scanResult.jobsClosed} closed · {scanResult.jobsArchived} archived ·{" "}
            {scanResult.jobsSuppressed} suppressed · {scanResult.jobsDeletedByAge} aged out
            {scanResult.errors > 0 && ` · ${scanResult.errors} errors`}
          </span>
        )}
        <button
          type="button"
          onClick={runScan}
          disabled={scanning}
          className="ml-auto shrink-0 rounded-md bg-[var(--accent)] px-3 py-1.5 text-[13px] font-medium text-[var(--accent-fg)] transition-colors duration-150 ease-out hover:bg-[var(--accent-hover)] active:scale-[0.98] disabled:opacity-50"
        >
          {scanning ? "Scanning…" : "Scan now"}
        </button>
      </AppToolbarSlot>

      <div className="flex items-center gap-1 border-b border-zinc-200 dark:border-zinc-800">
        {(["forYou", "all"] as JobsView[]).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => {
              setView(v);
              setSelectedJobId(null);
            }}
            className={`-mb-px border-b-2 px-3 py-1.5 text-sm font-medium ${
              view === v
                ? "border-zinc-900 text-zinc-900 dark:border-zinc-100 dark:text-zinc-100"
                : "border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-300"
            }`}
          >
            {v === "forYou" ? "For You" : "All Jobs"}
          </button>
        ))}
        {view === "all" && (
          <button
            type="button"
            onClick={() => setFiltersOpen((o) => !o)}
            aria-expanded={filtersOpen}
            aria-controls="jobs-filter-panel"
            className="ml-auto mb-1 rounded-md px-2.5 py-1 text-[12px] font-medium text-secondary transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] hover:text-primary active:scale-[0.98]"
            title={filtersOpen ? "Hide filters" : "Show filters"}
          >
            <span aria-hidden="true">{filtersOpen ? "\u25C0" : "\u25B6"}</span> Filters
          </button>
        )}
      </div>

      {view === "forYou" ? (
        !thresholdsLoaded ? (
          <p className="text-[13px] text-tertiary">Loading…</p>
        ) : (
          <Workbench
            selectedJobId={selectedJobId}
            list={
              <ForYouList
                candidateId={candidateId}
                thresholds={thresholds}
                search={filters.search}
                selectedJobId={selectedJobId}
                onSelect={setSelectedJobId}
              />
            }
          />
        )
      ) : (
        <div className="flex min-w-0 flex-col gap-4 lg:flex-row">
          {/* One instance only. A second copy hidden by CSS would still mount, still hold its own
           *  state and still render ~120 controls — the same duplicate-tree cost avoided elsewhere
           *  in the shell. Below lg the wrapper simply doesn't animate, so the panel stacks above
           *  the list at full width instead of collapsing. */}
          <motion.div
            id="jobs-filter-panel"
            initial={false}
            animate={desktopFilters ? { width: filtersOpen ? 256 : 0, opacity: filtersOpen ? 1 : 0 } : {}}
            transition={reduced ? { duration: 0 } : { type: "spring", duration: 0.26, bounce: 0 }}
            className="shrink-0 overflow-hidden"
            aria-hidden={desktopFilters && !filtersOpen}
          >
            <div className="lg:w-64">
              <JobFilterSidebar filters={filters} onChange={setFilters} companies={companies} />
            </div>
          </motion.div>
          <div className="min-w-0 flex-1">
            {loading || !thresholdsLoaded ? (
              <p className="text-sm text-zinc-500">Loading…</p>
            ) : (
              <Workbench
                selectedJobId={selectedJobId}
                list={
                  <JobList
                    jobs={jobs}
                    thresholds={thresholds}
                    selectedJobId={selectedJobId}
                    onSelect={setSelectedJobId}
                  />
                }
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
