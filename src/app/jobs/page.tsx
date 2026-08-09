"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useActiveCandidateId } from "@/lib/useActiveCandidateId";
import type { Company, JobWithCompany, ScanSummary } from "@/types";
import { DEFAULT_FILTERS, JobFilterSidebar, type JobFilterState } from "./JobFilterSidebar";
import { JobList } from "./JobList";
import { useLifecycleThresholds } from "./useLifecycleThresholds";

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
  const [filters, setFilters] = useState<JobFilterState>(DEFAULT_FILTERS);
  const [jobs, setJobs] = useState<JobWithCompany[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<ScanSummary | null>(null);
  const { thresholds, loaded: thresholdsLoaded } = useLifecycleThresholds();

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
    // Intentional: fetch-on-mount/filter-change with a loading flag, not a render loop.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadJobs();
  }, [loadJobs]);

  async function runScan() {
    setScanning(true);
    setScanResult(null);
    try {
      const res = await fetch("/api/scan", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const summary = (await res.json()) as ScanSummary;
      setScanResult(summary);
      await loadJobs();
    } finally {
      setScanning(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Jobs</h1>
        <div className="flex items-center gap-3">
          {scanResult && (
            <span className="text-xs text-zinc-500">
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
            className="rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {scanning ? "Scanning…" : "Scan now"}
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-4 lg:flex-row">
        <JobFilterSidebar filters={filters} onChange={setFilters} companies={companies} />
        <div className="flex-1">
          {loading || !thresholdsLoaded ? (
            <p className="text-sm text-zinc-500">Loading…</p>
          ) : (
            <JobList jobs={jobs} thresholds={thresholds} />
          )}
        </div>
      </div>
    </div>
  );
}
