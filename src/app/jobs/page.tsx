"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useActiveCandidateId } from "@/lib/useActiveCandidateId";
import type { Company, JobWithCompany, ScanSummary } from "@/types";
import { DEFAULT_FILTERS, JobFilterSidebar, type JobFilterState } from "./JobFilterSidebar";
import { Aperture } from "./Aperture";
import type { QueueItem } from "./queue";
import { ForYouList } from "./ForYouList";
import { JobList } from "./JobList";
import { Workbench } from "./Workbench";
import { JobListSkeleton, LoadingRegion } from "./Skeletons";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { AppToolbarSlot } from "@/components/AppToolbarSlot";
import { useLifecycleThresholds } from "./useLifecycleThresholds";

type JobsView = "forYou" | "all";

/** Holds the workspace's shape while data arrives, so nothing collapses and snaps back. */
function WorkspaceLoading() {
  return (
    <div className="flex h-[calc(100dvh-10rem)] min-h-[420px] overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border)] bg-surface">
      <LoadingRegion label="Loading jobs" />
      <div className="min-w-0 flex-1">
        <JobListSkeleton />
      </div>
      <div className="hidden w-[42%] shrink-0 border-l border-[var(--separator)] lg:block" />
    </div>
  );
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
  /* The visible ordered queue, published by whichever list is mounted. Previous/Next reads this —
   * never its own ordering — so click, Prev/Next and arrow keys can never disagree. */
  const [queue, setQueue] = useState<QueueItem[]>([]);
  // The filter surface is now a popover, so it starts closed. Discoverability lives in the command
  // bar instead: the trigger is always visible and carries a live count of what is active.
  const [filtersOpen, setFiltersOpen] = useState(false);
  /**
   * Search moved out of the collapsible filter panel and into the toolbar, so it stays reachable
   * when filters are closed. It is also debounced now: it previously committed on every keystroke,
   * and each commit re-ran the whole /api/jobs query — typing "data engineer" fired 13 full
   * requests over 16,005 jobs. The query itself is untouched; only how often it is asked changed.
   */
  /* Seeded from ?q= so the command palette's "Search jobs for …" lands on a real result set rather
   * than an empty page. Read once, at mount — the URL is an entry point, not a live binding. */
  const [searchDraft, setSearchDraft] = useState(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("q") ?? "";
  });
  const committedSearch = useRef("");
  const reduced = useReducedMotion() ?? false;
  const filterAnchorRef = useRef<HTMLDivElement>(null);
  /** How many filters differ from their default. Presentation only — reads JobFilterState. */
  const activeFilterCount = (Object.keys(DEFAULT_FILTERS) as (keyof JobFilterState)[]).filter((k) => {
    const cur = filters[k];
    const def = DEFAULT_FILTERS[k];
    return Array.isArray(cur) ? cur.length !== (def as unknown[]).length : cur !== def;
  }).length;
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

  // Escape and outside-click close the panel; focus returns to the trigger it came from.
  useEffect(() => {
    if (!filtersOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setFiltersOpen(false);
        filterAnchorRef.current?.querySelector("button")?.focus();
      }
    }
    function onDown(e: MouseEvent) {
      if (filterAnchorRef.current && !filterAnchorRef.current.contains(e.target as Node)) setFiltersOpen(false);
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [filtersOpen]);

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
        {/* The aperture's one additional placement. It is a wayfinding mark, not an indicator —
         *  identical on every screen and in every state. */}
        <span className="flex shrink-0 items-center gap-2">
          <Aperture variant="mark" />
          <h1 className="text-[14px] font-semibold tracking-[-0.01em] text-primary">Jobs</h1>
        </span>

        {/* Segmented view control — one capsule with a sliding lit indicator, rather than two
         *  underlined tabs floating in the content area. */}
        <div className="ml-1 hidden shrink-0 items-center rounded-[9px] bg-[var(--z0-bg)] p-[3px] shadow-[inset_0_1px_2px_var(--edge-lo)] sm:flex">
          {(["forYou", "all"] as JobsView[]).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => {
                setView(v);
                setSelectedJobId(null);
              }}
              aria-pressed={view === v}
              className={`relative rounded-[7px] px-2.5 py-1 text-[12px] font-medium transition-colors duration-150 ease-out ${
                view === v
                  ? "bg-[var(--z3-bg)] text-primary shadow-[var(--lift-1),inset_0_1px_0_var(--edge-hi)]"
                  : "text-tertiary hover:text-primary"
              }`}
            >
              {v === "forYou" ? "For You" : "All Jobs"}
            </button>
          ))}
        </div>

        {/* A recessed well, not a bordered box. The field measured 1.08:1 against the command bar
         *  on tone alone; a 3:1 outline would read as an enterprise form control, so the field is
         *  identified by sinking (well tone + inset edge) plus a persistent glyph. */}
        <label className="relative min-w-0 flex-1 md:max-w-sm">
          <span className="sr-only">Search jobs by title, company or description</span>
          <svg
            aria-hidden="true"
            viewBox="0 0 16 16"
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-tertiary"
          >
            <circle cx="7" cy="7" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M10.2 10.2 L13.5 13.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            type="search"
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            placeholder="Search title, company, description…"
            className="w-full rounded-[9px] bg-[var(--well-bg)] py-1.5 pl-8 pr-3 text-[12.5px] text-primary shadow-[var(--well-edge)] outline-none transition-shadow duration-150 ease-out placeholder:text-tertiary focus:shadow-[var(--well-edge),0_0_0_2px_var(--accent-soft)]"
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
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {view === "all" && (
            <div ref={filterAnchorRef} className="relative">
              <button
                type="button"
                onClick={() => setFiltersOpen((o) => !o)}
                aria-expanded={filtersOpen}
                aria-controls="jobs-filter-panel"
                aria-haspopup="dialog"
                className={`flex items-center gap-1.5 rounded-[9px] px-2.5 py-1.5 text-[12.5px] font-medium transition-colors duration-150 ease-out active:scale-[0.98] ${
                  filtersOpen ? "bg-[var(--z0-bg)] text-primary shadow-[inset_0_1px_2px_var(--edge-lo)]" : "text-secondary hover:text-primary"
                }`}
              >
                Filters
                {activeFilterCount > 0 && (
                  <span className="grid h-4 min-w-4 place-items-center rounded-full bg-[var(--accent)] px-1 text-[10px] font-semibold tabular-nums text-[var(--accent-fg)]">
                    {activeFilterCount}
                  </span>
                )}
              </button>

              {/* Z5 — emerges from its trigger, not from the viewport. */}
              <AnimatePresence>
                {filtersOpen && (
                  <motion.div
                    id="jobs-filter-panel"
                    role="dialog"
                    aria-label="Job filters"
                    style={{ transformOrigin: "top right" }}
                    initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: -6 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.98, y: -4 }}
                    transition={reduced ? { duration: 0.11 } : { type: "spring", duration: 0.22, bounce: 0 }}
                    className="plane plane-5 absolute right-0 top-[calc(100%+8px)] z-50 max-h-[min(70vh,560px)] w-[min(94vw,26rem)] overflow-y-auto"
                  >
                    <JobFilterSidebar filters={filters} onChange={setFilters} companies={companies} />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}
          <button
            type="button"
            onClick={runScan}
            disabled={scanning}
            className="rounded-[9px] bg-[var(--accent)] px-3 py-1.5 text-[12.5px] font-semibold text-[var(--accent-fg)] shadow-[var(--lift-1),inset_0_1px_0_rgba(255,255,255,0.22)] transition-colors duration-150 ease-out hover:bg-[var(--accent-hover)] active:scale-[0.98] disabled:opacity-50"
          >
            {scanning ? "Scanning…" : "Scan now"}
          </button>
        </div>
      </AppToolbarSlot>

      <div className="flex items-center gap-1 border-b border-[var(--separator)] sm:hidden">
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
      </div>

      {view === "forYou" ? (
        !thresholdsLoaded ? (
          <WorkspaceLoading />
        ) : (
          <Workbench
            selectedJobId={selectedJobId}
            queue={queue}
            onSelect={setSelectedJobId}
            list={
              <ForYouList
                candidateId={candidateId}
                thresholds={thresholds}
                search={filters.search}
                selectedJobId={selectedJobId}
                onSelect={setSelectedJobId}
                onQueueChange={setQueue}
              />
            }
          />
        )
      ) : (
        <div className="flex min-w-0 flex-col gap-4 lg:flex-row">
          <div className="min-w-0 flex-1">
            {loading || !thresholdsLoaded ? (
              <WorkspaceLoading />
            ) : (
              <Workbench
                selectedJobId={selectedJobId}
                queue={queue}
                onSelect={setSelectedJobId}
                list={
                  <JobList
                    jobs={jobs}
                    thresholds={thresholds}
                    selectedJobId={selectedJobId}
                    onSelect={setSelectedJobId}
                    onQueueChange={setQueue}
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
