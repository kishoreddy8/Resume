"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useActiveCandidateId } from "@/lib/useActiveCandidateId";
import type { Company, JobWithCompany } from "@/types";
import { DEFAULT_FILTERS, JobFilterSidebar, type JobFilterState } from "./JobFilterSidebar";
import { Aperture } from "./Aperture";
import type { QueueItem } from "./queue";
import { ForYouList } from "./ForYouList";
import { JobList } from "./JobList";
import { WorkflowJobsList } from "./WorkflowJobsList";
import { JobListSkeleton, LoadingRegion } from "./Skeletons";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { AppToolbarActions, AppToolbarSlot } from "@/components/AppToolbarSlot";
import { BottomSheet } from "@/components/ui";
import { useLifecycleThresholds } from "./useLifecycleThresholds";

type JobsView = "forYou" | "all" | "saved" | "tailoring" | "needsReview";

const JOB_VIEWS: { id: JobsView; label: string }[] = [
  { id: "forYou", label: "For You" },
  { id: "all", label: "All Jobs" },
  { id: "saved", label: "Saved" },
  { id: "tailoring", label: "Tailoring" },
  { id: "needsReview", label: "Needs Review" },
];

/** Holds the workspace's shape while data arrives, so nothing collapses and snaps back. */
function WorkspaceLoading() {
  return (
    <div className="min-h-[420px] overflow-hidden rounded-[22px] border border-[var(--border)] bg-surface p-4 shadow-[var(--lift-1)]">
      <LoadingRegion label="Loading jobs" />
      <JobListSkeleton />
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
  // The highlighted row. Deep-linkable via ?job=<id> so the URL reflects the current state, and
  // intentionally NOT persisted anywhere else. Selection now only drives the highlight and
  // arrow-key movement — opening a job navigates to its workspace.
  const [selectedJobId, setSelectedJobId] = useState<number | null>(null);
  /* The visible ordered queue, published by whichever list is mounted. Its consumer was the
   * detail pane's Previous/Next; with jobs now opening in their own workspace nothing reads it, but
   * the lists still publish unconditionally, so the setter stays and the value is not bound. */
  const [, setQueue] = useState<QueueItem[]>([]);
  // The filter surface is now a popover, so it starts closed. Discoverability lives in the command
  // bar instead: the trigger is always visible and carries a live count of what is active.
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Same filters, same state — only the surface differs: a BottomSheet below `lg` instead of the
  // toolbar-anchored dropdown, which does not read as intentional at phone widths.
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
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

  /* The company list exists solely to populate one dropdown inside the filter popover, which
   * starts closed. Fetching it on mount cost 4.7 MB and measured 3,404ms on a warm production
   * server — it was the single largest thing on the page, and it competed for connections with the
   * feed request that actually renders the list. Deferred to the first time the popover opens, and
   * fetched once. Nothing about the filter's behaviour changes; it is the same data, later. */
  const companiesRequested = useRef(false);
  useEffect(() => {
    // Either surface (the desktop dropdown or the mobile BottomSheet) can be the first to open —
    // both render the same JobFilterSidebar, so both need this fetched exactly once, on whichever
    // opens first.
    if ((!filtersOpen && !mobileFiltersOpen) || companiesRequested.current) return;
    companiesRequested.current = true;
    /* Only id and name are rendered in this dropdown. The full row set is 4.8 MB across ~4,000
     * companies; this projection is ~2% of it. */
    fetch("/api/companies?fields=minimal")
      .then((r) => r.json())
      .then((d) => setCompanies(d.companies ?? []))
      .catch(() => {
        // Leave the dropdown empty rather than blocking the filter panel; the rest still works.
        companiesRequested.current = false;
      });
  }, [filtersOpen, mobileFiltersOpen]);

  useEffect(() => {
    // Only the "All Jobs" view needs the unranked/filtered listJobs fetch — For You loads its own
    // ranked data independently (see ForYouList). Avoids a wasted request on the default view.
    if (view !== "all") return;
    // Intentional: fetch-on-mount/filter-change with a loading flag, not a render loop.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadJobs();
  }, [loadJobs, view]);

  return (
    <div className="mx-auto flex w-full max-w-[var(--candidate-page-max)] flex-col gap-5 pb-10">
      {/* The toolbar carries what this page IS. What it can DO sits on the other side of the
       *  search, and what it FILTERS sits in the page's own control row below — see the comment on
       *  APP_TOOLBAR_ACTIONS_SLOT_ID. Portalling all three into one left-hand anchor put the page's
       *  search field and filter control underneath the global one. */}
      <AppToolbarSlot>
        {/* The aperture's one additional placement. It is a wayfinding mark, not an indicator —
         *  identical on every screen and in every state. */}
        <span className="flex shrink-0 items-center gap-2">
          <Aperture variant="mark" />
          <h1 className="text-[16px] font-semibold tracking-[-0.01em] text-primary">Jobs</h1>
        </span>
      </AppToolbarSlot>

      <AppToolbarActions>
        {view === "all" && (
          <div ref={filterAnchorRef} className="relative hidden lg:block">
            <button
              type="button"
              onClick={() => setFiltersOpen((o) => !o)}
              aria-expanded={filtersOpen}
              aria-controls="jobs-filter-panel"
              aria-haspopup="dialog"
              className={`flex h-10 items-center gap-2 rounded-[10px] px-3.5 text-[14px] font-medium transition-colors duration-150 ease-out active:scale-[0.98] ${
                filtersOpen ? "bg-[var(--z0-bg)] text-primary shadow-[inset_0_1px_2px_var(--edge-lo)]" : "text-secondary hover:text-primary"
              }`}
            >
              Filters
              {activeFilterCount > 0 && (
                <span className="grid h-[19px] min-w-[19px] place-items-center rounded-full bg-[var(--accent)] px-1.5 text-[11.5px] font-semibold tabular-nums text-[var(--accent-fg)]">
                  {activeFilterCount}
                </span>
              )}
            </button>

            {/* Z5 — emerges from its trigger, not from the viewport. Desktop/laptop only — the
             *  narrow-viewport equivalent is the BottomSheet below, since a viewport-anchored
             *  dropdown of this width does not read as intentional on a phone. */}
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
      </AppToolbarActions>

      {/* Desktop/laptop — the existing decorative hero, unchanged. */}
      <section className="relative hidden overflow-hidden rounded-[24px] border border-[color-mix(in_oklab,var(--accent)_16%,var(--border))] bg-[linear-gradient(125deg,color-mix(in_oklab,var(--accent-soft)_72%,var(--surface)),var(--surface)_58%,color-mix(in_oklab,var(--accent-soft)_35%,var(--surface)))] px-5 py-7 shadow-[var(--lift-1)] md:px-8 lg:block">
        <div aria-hidden="true" className="absolute -right-16 -top-20 h-56 w-56 rounded-full bg-[var(--accent-soft)] blur-3xl" />
        <div aria-hidden="true" className="absolute right-8 top-1/2 hidden h-24 w-44 -translate-y-1/2 md:block">
          <span className="absolute inset-x-0 top-1/2 h-px bg-[linear-gradient(90deg,transparent,color-mix(in_oklab,var(--accent)_26%,transparent),transparent)]" />
          <span className="absolute left-8 top-6 h-12 w-12 rotate-45 rounded-[14px] border border-[color-mix(in_oklab,var(--accent)_14%,transparent)] bg-[color-mix(in_oklab,var(--surface)_50%,transparent)]" />
          <span className="absolute right-5 top-3 h-16 w-16 rotate-45 rounded-[18px] border border-[color-mix(in_oklab,var(--accent)_18%,transparent)] bg-[color-mix(in_oklab,var(--accent-soft)_35%,transparent)]" />
        </div>
        <div className="relative max-w-2xl">
          <p className="text-[13px] font-bold uppercase tracking-[0.12em] text-[var(--accent)]">Candidate workspace</p>
          <h1 className="mt-2 text-[30px] font-semibold leading-tight tracking-[-0.035em] text-primary md:text-[38px]">Find work worth pursuing.</h1>
          <p className="mt-3 max-w-xl text-[14.5px] leading-relaxed text-secondary md:text-[15.5px]">Prioritized matches, saved opportunities, and resume work—organized around the next decision you need to make.</p>
        </div>
      </section>

      {/* Mobile/tablet — a clean, compact header instead of the decorative hero. Title, one line of
       *  truthful supporting copy, then straight into the view tabs/search below. No claim of an
       *  AI-search capability that does not exist — the field beneath this narrows the same way it
       *  always has. */}
      <div className="lg:hidden">
        <h1 className="text-[26px] font-bold tracking-[-0.02em] text-primary">Jobs</h1>
        <p className="mt-1 text-[13.5px] text-secondary">Matched to your profile.</p>
      </div>

      {/* The page's own control row, aligned to the page container rather than to the toolbar.
       *  The view switch and the feed's search live here because they filter what is directly
       *  below them — and because the toolbar already holds a search that means something else:
       *  the global one navigates, this one narrows the list you are looking at. */}
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
        <div className="flex min-w-0 items-center gap-2">
          <div role="tablist" aria-label="Job views" className="flex min-w-0 overflow-x-auto rounded-[14px] bg-[var(--z0-bg)] p-1 shadow-[inset_0_1px_2px_var(--edge-lo)]">
          {JOB_VIEWS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              onClick={() => {
                setView(id);
                setSelectedJobId(null);
              }}
              role="tab"
              aria-selected={view === id}
              className={`premium-active-tab relative h-12 shrink-0 rounded-[11px] px-5 text-[14.5px] font-semibold transition-colors duration-150 ease-out ${
                view === id
                  ? "bg-[var(--accent)] text-[var(--accent-fg)] shadow-[var(--lift-1)]"
                  : "text-secondary hover:bg-[var(--surface-hover)] hover:text-primary"
              }`}
            >
              {label}
            </button>
          ))}
          </div>

          {view === "all" && (
            <button
              type="button"
              onClick={() => setMobileFiltersOpen(true)}
              aria-haspopup="dialog"
              className="flex h-11 shrink-0 items-center gap-1.5 rounded-[11px] border border-[var(--border)] bg-surface px-3 text-[13.5px] font-medium text-primary lg:hidden"
            >
              Filters
              {activeFilterCount > 0 && (
                <span className="grid h-[18px] min-w-[18px] place-items-center rounded-full bg-[var(--accent)] px-1 text-[11px] font-semibold tabular-nums text-[var(--accent-fg)]">
                  {activeFilterCount}
                </span>
              )}
            </button>
          )}
        </div>

        {/* A recessed well, not a bordered box. The field measured 1.08:1 against the command bar
         *  on tone alone; a 3:1 outline would read as an enterprise form control, so the field is
         *  identified by sinking (well tone + inset edge) plus a persistent glyph. */}
        <label className="relative min-w-0 flex-1 xl:ml-auto xl:max-w-[440px]">
          <span className="sr-only">Narrow this list by title, company or description</span>
          <svg
            aria-hidden="true"
            viewBox="0 0 16 16"
            className="pointer-events-none absolute left-3.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-tertiary"
          >
            <circle cx="7" cy="7" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M10.2 10.2 L13.5 13.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            type="search"
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            placeholder="Narrow this list…"
            className="h-11 w-full rounded-[11px] bg-[var(--well-bg)] pl-11 pr-3.5 text-[14.5px] text-primary shadow-[var(--well-edge)] outline-none transition-shadow duration-150 ease-out placeholder:text-tertiary focus:shadow-[var(--well-edge),0_0_0_2px_var(--accent-soft)]"
          />
        </label>

      </div>

      {view === "all" && (
        <BottomSheet open={mobileFiltersOpen} onClose={() => setMobileFiltersOpen(false)} title="Filters">
          <JobFilterSidebar filters={filters} onChange={setFilters} companies={companies} />
        </BottomSheet>
      )}

      {view === "forYou" || view === "saved" ? (
        !thresholdsLoaded ? (
          <WorkspaceLoading />
        ) : (
          <ForYouList
            mode={view}
            candidateId={candidateId}
            thresholds={thresholds}
            search={filters.search}
            selectedJobId={selectedJobId}
            onSelect={setSelectedJobId}
            onQueueChange={setQueue}
            onExploreJobs={() => setView("forYou")}
          />
        )
      ) : view === "all" ? (
        <div className="flex min-w-0 flex-col gap-4 lg:flex-row">
          <div className="min-w-0 flex-1">
            {loading || !thresholdsLoaded ? (
              <WorkspaceLoading />
            ) : (
              <JobList
                jobs={jobs}
                thresholds={thresholds}
                selectedJobId={selectedJobId}
                onSelect={setSelectedJobId}
                onQueueChange={setQueue}
              />
            )}
          </div>
        </div>
      ) : (
        <WorkflowJobsList
          candidateId={candidateId}
          view={view}
          onExploreJobs={() => setView("forYou")}
        />
      )}
    </div>
  );
}
