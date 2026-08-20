"use client";

import { useEffect, useState } from "react";
import { LoadingRegion, PageHeader, SkeletonRows, Surface } from "@/components/ui";
import { H1bBadge } from "@/components/H1bBadge";
import { useActiveCandidateId } from "@/lib/useActiveCandidateId";
import { CompanyIntelligence } from "./CompanyIntelligence";
import { PROVIDER_LABELS } from "@/lib/ats/providerLabels";
import type { Company, CompanyResolutionStatus, SourceType } from "@/types";

const COMPANY_LIMIT = 100;
const UNRESOLVED_LIMIT = 25;
const COMPANY_STEP = 200;

const RESOLUTION_LABELS: Record<CompanyResolutionStatus, string> = {
  VERIFIED: "Verified",
  GENERIC_SUPPORTED: "Generic scrape",
  UNRESOLVED: "Unresolved",
  NEEDS_ADAPTER: "Needs adapter",
  FAILED_TEMPORARY: "Temporarily unreachable",
};

const RESOLUTION_STYLES: Record<CompanyResolutionStatus, string> = {
  VERIFIED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  GENERIC_SUPPORTED: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300",
  UNRESOLVED: "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  NEEDS_ADAPTER: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  FAILED_TEMPORARY: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
};

function ResolutionBadge({ status }: { status: CompanyResolutionStatus }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${RESOLUTION_STYLES[status]}`}>
      {RESOLUTION_LABELS[status]}
    </span>
  );
}

const UNRESOLVED_STATUSES: CompanyResolutionStatus[] = ["UNRESOLVED", "NEEDS_ADAPTER", "FAILED_TEMPORARY"];

function RetryDiscoveryButton({ company, onChanged }: { company: Company; onChanged: () => void }) {
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function retry() {
    setRetrying(true);
    setError(null);
    try {
      const res = await fetch(`/api/companies/${company.id}/discover`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "Retry failed");
        return;
      }
      onChanged();
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div className="text-right">
      <button
        type="button"
        disabled={retrying}
        onClick={retry}
        className="rounded border border-zinc-300 px-2 py-1 text-xs font-medium hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
      >
        {retrying ? "Retrying…" : "Retry Discovery"}
      </button>
      {error && <div className="mt-1 text-xs text-red-600">{error}</div>}
    </div>
  );
}

/**
 * Deliberately its own prominent section, not folded into the main table — see AGENTS.md §17
 * ("unsupported sources should be easy to find rather than buried"). Company source resolution
 * (this) and Phase 2's candidate-facing NEEDS_REVIEW match decision are unrelated concepts; this
 * section is purely about whether Career-Ops could find a scannable source at all.
 */
function UnsupportedSourcesSection({ companies, onChanged }: { companies: Company[]; onChanged: () => void }) {
  const unresolved = companies.filter((c) => UNRESOLVED_STATUSES.includes(c.resolution_status));
  if (unresolved.length === 0) return null;
  /* Capped for the same reason the main table is: ~1,100 unresolved sources rendered in full were
   * most of this page's DOM. The count above the table always states the real total. */
  const shown = unresolved.slice(0, UNRESOLVED_LIMIT);
  const hidden = unresolved.length - shown.length;

  return (
    <section className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/20">
      <div>
        <h2 className="text-sm font-semibold text-amber-900 dark:text-amber-200">
          Unsupported / Unresolved Sources ({unresolved.length})
        </h2>
        <p className="text-xs text-amber-800/80 dark:text-amber-300/70">
          JobHunt could not confirm a scannable source for these companies. They stay in the
          registry — nothing here creates placeholder jobs. Fix the URL and retry, or leave as-is.
        </p>
      </div>
      <div className="overflow-hidden rounded-lg border border-amber-200 bg-white dark:border-amber-900 dark:bg-zinc-900">
        <table className="w-full text-left text-sm">
          <thead className="bg-amber-100/60 text-xs uppercase tracking-wide text-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
            <tr>
              <th className="px-3 py-2 font-medium">Company</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Reason</th>
              <th className="px-3 py-2 font-medium">Last attempt</th>
              <th className="px-3 py-2 font-medium"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-amber-100 dark:divide-amber-900/40">
            {shown.map((c) => (
              <tr key={c.id}>
                <td className="px-3 py-2">
                  <div className="font-medium">{c.name}</div>
                  {c.career_page_url && (
                    <a href={c.career_page_url} target="_blank" rel="noopener noreferrer" className="text-xs text-zinc-400 hover:underline">
                      {c.career_page_url}
                    </a>
                  )}
                </td>
                <td className="px-3 py-2">
                  <ResolutionBadge status={c.resolution_status} />
                  {c.suspected_ats && (
                    <div className="mt-0.5 text-xs text-zinc-500">Suspected: {c.suspected_ats}</div>
                  )}
                </td>
                <td className="max-w-xs px-3 py-2 text-xs text-zinc-600 dark:text-zinc-400">
                  {c.discovery_reason ?? "Never attempted"}
                </td>
                <td className="px-3 py-2 text-xs text-zinc-400">{c.discovery_attempted_at ?? "never"}</td>
                <td className="px-3 py-2">
                  <RetryDiscoveryButton company={c} onChanged={onChanged} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hidden > 0 && (
        <p className="px-1 text-[11.5px] tabular-nums text-tertiary">
          Showing {shown.length} of {unresolved.length.toLocaleString()} unresolved sources.
        </p>
      )}
    </section>
  );
}

const ADVANCED_ATS_SOURCES: { value: Exclude<SourceType, "career_link">; label: string; placeholder: string }[] = [
  { value: "greenhouse", label: "Greenhouse", placeholder: "board token, e.g. gitlab" },
  { value: "ashby", label: "Ashby", placeholder: "board name, e.g. linear" },
  { value: "lever", label: "Lever", placeholder: "company slug, e.g. palantir" },
  { value: "workday", label: "Workday", placeholder: "tenant|host|site, e.g. hp|wd5|ExternalCareerSite" },
  { value: "smartrecruiters", label: "SmartRecruiters", placeholder: "company identifier, e.g. ServiceNow" },
  { value: "adp_wfn", label: "ADP Workforce Now", placeholder: "cid|ccId|lang" },
  { value: "paylocity", label: "Paylocity", placeholder: "company UUID|slug" },
  { value: "icims", label: "iCIMS", placeholder: "tenant.icims.com" },
  { value: "ukg_pro", label: "UKG Pro Recruiting", placeholder: "host|tenant|board UUID" },
  { value: "bamboohr", label: "BambooHR", placeholder: "tenant, e.g. example-company" },
  { value: "oracle_recruiting_cloud", label: "Oracle Recruiting Cloud", placeholder: "host|site, e.g. tenant.fa.us2.oraclecloud.com|CX" },
  { value: "workable", label: "Workable", placeholder: "account slug, e.g. corcentric" },
  { value: "rippling", label: "Rippling Recruiting", placeholder: "job-board slug, e.g. aerospike-inc" },
  { value: "paycom", label: "Paycom", placeholder: "32-character client key" },
  { value: "jazzhr", label: "JazzHR", placeholder: "tenant, e.g. ouster" },
  { value: "jobvite", label: "Jobvite", placeholder: "career-site tenant, e.g. riskspan" },
  { value: "breezy", label: "Breezy HR", placeholder: "tenant, e.g. bitdeer" },
  { value: "teamtailor", label: "Teamtailor", placeholder: "tenant, e.g. passivelogic" },
  { value: "applicantpro", label: "ApplicantPro", placeholder: "tenant, e.g. mapcommunications" },
  { value: "pinpoint", label: "Pinpoint", placeholder: "tenant, e.g. utilitiesone" },
  { value: "clearcompany", label: "ClearCompany", placeholder: "tenant, e.g. paycargo" },
  { value: "personio", label: "Personio", placeholder: "tenant, e.g. example-gmbh" },
  { value: "applicantstack", label: "ApplicantStack", placeholder: "tenant, e.g. dashiell" },
  { value: "comeet", label: "Comeet", placeholder: "slug|company UID, e.g. lumus|62.00F" },
  { value: "cats", label: "CATS", placeholder: "host|portal ID, e.g. example.catsone.com|736" },
  { value: "gohire", label: "GoHire", placeholder: "8-character client hash, e.g. 9t3BsLUp" },
  { value: "newton", label: "Newton / Paycor", placeholder: "32-character client ID" },
  { value: "silkroad", label: "SilkRoad", placeholder: "account|site, e.g. TraylorBros|TraylorCareers" },
  { value: "jobdiva", label: "JobDiva", placeholder: "host|64-char account|company ID|division IDs" },
  { value: "taleo", label: "Taleo", placeholder: "tenant host|career section, e.g. example.taleo.net|external" },
  { value: "phenom", label: "Phenom", placeholder: "host|locale, e.g. careers.example.com|us/en" },
  { value: "adp_rm", label: "ADP Recruiting Management", placeholder: "MyJobs slug|site UUID|orgoid|client ID" },
  { value: "eightfold", label: "Eightfold", placeholder: "tenant host|embedded domain" },
  { value: "cornerstone", label: "Cornerstone", placeholder: "tenant.csod.com|career site ID|corp" },
  { value: "avature", label: "Avature", placeholder: "host|template or legacy|portal path|page" },
  { value: "successfactors", label: "SAP SuccessFactors", placeholder: "career{N}.successfactors.com|company ID" },
];

interface DetectionPreview {
  detected: SourceType | null;
  resolutionStatus: CompanyResolutionStatus;
  reason: string;
}

function useDebouncedDetection(url: string) {
  const [preview, setPreview] = useState<DetectionPreview | undefined>(undefined); // undefined = not yet checked
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (!url || !/^https?:\/\/.+\..+/.test(url)) {
      // Intentional: resetting detection state as the debounced url prop changes, not a render loop.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPreview(undefined);
      return;
    }
    let cancelled = false;
    setChecking(true);
    const handle = setTimeout(async () => {
      try {
        const res = await fetch("/api/companies/detect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url }),
        });
        if (cancelled) return;
        if (res.ok) {
          const data = await res.json();
          setPreview({ detected: data.detected ?? null, resolutionStatus: data.resolutionStatus, reason: data.reason });
        } else {
          setPreview(undefined);
        }
      } catch {
        if (!cancelled) setPreview(undefined);
      } finally {
        if (!cancelled) setChecking(false);
      }
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [url]);

  return { preview, checking };
}

function AddCompanyForm({ onAdded }: { onAdded: () => void }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const { preview, checking } = useDebouncedDetection(url);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const res = await fetch("/api/companies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, url }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(JSON.stringify(data.error));
      }
      setName("");
      setUrl("");
      onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add company");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-3 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"
    >
      <h2 className="text-sm font-semibold">Add a company</h2>
      <p className="text-xs text-zinc-500">
        Paste the company&apos;s careers page URL — the board&apos;s own Greenhouse/Ashby/Lever/Workday
        URL, or their regular careers page if it embeds one of those. The ATS is detected
        automatically; if none is found, it falls back to a best-effort generic scrape.
      </p>
      <div className="flex flex-wrap gap-2">
        <input
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Company name"
          className="min-w-[160px] flex-1 rounded border border-zinc-300 px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
        />
        <input
          required
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://company.com/careers"
          className="min-w-[220px] flex-1 rounded border border-zinc-300 px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
        />
        <button
          type="submit"
          disabled={saving}
          className="rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
        >
          Add
        </button>
      </div>
      <div className="text-xs text-zinc-500">
        {checking && "Checking…"}
        {!checking && preview?.detected && (
          <span className="text-emerald-700 dark:text-emerald-400">
            Detected: {PROVIDER_LABELS[preview.detected]}
          </span>
        )}
        {!checking && preview && !preview.detected && preview.resolutionStatus === "GENERIC_SUPPORTED" && (
          <span>No known ATS detected — will use a generic career-page scrape of {preview.reason.split(": ").pop()}.</span>
        )}
        {!checking && preview && !preview.detected && preview.resolutionStatus === "NEEDS_ADAPTER" && (
          <span className="text-amber-700 dark:text-amber-400">Recognized ATS with no connector yet — {preview.reason}</span>
        )}
        {!checking && preview && !preview.detected && (preview.resolutionStatus === "UNRESOLVED" || preview.resolutionStatus === "FAILED_TEMPORARY") && (
          <span className="text-amber-700 dark:text-amber-400">{preview.reason}</span>
        )}
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </form>
  );
}

function AdvancedManualForm({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [sourceType, setSourceType] = useState<Exclude<SourceType, "career_link">>("greenhouse");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const res = await fetch("/api/companies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, source_type: sourceType, ats_board_token: token }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(JSON.stringify(data.error));
      }
      setName("");
      setToken("");
      onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add company");
    } finally {
      setSaving(false);
    }
  }

  const current = ADVANCED_ATS_SOURCES.find((s) => s.value === sourceType)!;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs text-zinc-500 underline hover:text-zinc-800 dark:hover:text-zinc-200"
      >
        Advanced: add by exact board token instead
      </button>
    );
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-3 rounded-lg border border-zinc-200 bg-white p-4 text-sm dark:border-zinc-800 dark:bg-zinc-900"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Advanced: add by board token</h2>
        <button type="button" onClick={() => setOpen(false)} className="text-xs text-zinc-500 underline">
          Hide
        </button>
      </div>
      <p className="text-xs text-zinc-500">
        Use this when you already know the exact board identifier, or auto-detection picked the
        wrong thing.
      </p>
      <div className="flex flex-wrap gap-2">
        <input
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Company name"
          className="min-w-[160px] flex-1 rounded border border-zinc-300 px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
        />
        <select
          value={sourceType}
          onChange={(e) => setSourceType(e.target.value as Exclude<SourceType, "career_link">)}
          className="rounded border border-zinc-300 px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
        >
          {ADVANCED_ATS_SOURCES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <input
          required
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={current.placeholder}
          className="min-w-[200px] flex-1 rounded border border-zinc-300 px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
        />
        <button
          type="submit"
          disabled={saving}
          className="rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
        >
          Add
        </button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </form>
  );
}

function CompanyRow({ company, onChanged }: { company: Company; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  /* Observed-intelligence panel. Collapsed by default and fetched only on open, so the list itself
   * costs nothing extra — this page already carries a large corpus. */
  const [showIntel, setShowIntel] = useState(false);
  const candidateId = useActiveCandidateId();

  async function scanThis() {
    setBusy(true);
    try {
      await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: company.id }),
      });
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive() {
    setBusy(true);
    try {
      await fetch(`/api/companies/${company.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: company.is_active === 1 ? false : true }),
      });
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm(`Delete ${company.name} and all its jobs? This can't be undone.`)) return;
    setBusy(true);
    try {
      await fetch(`/api/companies/${company.id}`, { method: "DELETE" });
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  const row = (
    <tr className={company.is_active ? "" : "opacity-50"}>
      <td className="px-3 py-2">
        <div className="flex items-center gap-1.5">
          <span className="font-medium">{company.name}</span>
          <ResolutionBadge status={company.resolution_status} />
        </div>
        <div className="text-xs text-zinc-500">
          {company.source_type}
          {company.ats_board_token ? `:${company.ats_board_token}` : ""}
        </div>
        {company.career_page_url && (
          <a
            href={company.career_page_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-zinc-400 hover:underline"
          >
            {company.career_page_url}
          </a>
        )}
      </td>
      <td className="px-3 py-2 max-w-xs">
        <H1bBadge confidence={company.h1b_confidence} />
        {company.h1b_match_employer_name && (
          <div className="mt-0.5 text-xs text-zinc-500">
            {company.h1b_match_tier} match: &quot;{company.h1b_match_employer_name}&quot;
            {company.h1b_match_tier === "fuzzy" && ` (${company.h1b_match_score}% similarity)`}
            {" · "}
            {company.h1b_lca_count} certified LCA{company.h1b_lca_count === 1 ? "" : "s"}
            {company.h1b_latest_fiscal_year && ` · latest FY${company.h1b_latest_fiscal_year}`}
          </div>
        )}
        {company.h1b_confidence_evidence && (
          <div className="mt-0.5 text-xs text-zinc-400" title={company.h1b_confidence_evidence}>
            {company.h1b_confidence_evidence}
          </div>
        )}
        {company.h1b_updated_at && (
          <div className="mt-0.5 text-[10px] text-zinc-400">Updated {company.h1b_updated_at}</div>
        )}
      </td>
      <td className="px-3 py-2 text-xs text-zinc-500">
        {company.last_scan_status === "error" ? (
          <span className="text-red-600" title={company.last_scan_error ?? ""}>
            error
          </span>
        ) : (
          company.last_scanned_at ?? "never"
        )}
        {company.notes && (
          <div className="mt-1 max-w-xs text-amber-700 dark:text-amber-500">{company.notes}</div>
        )}
      </td>
      <td className="px-3 py-2 text-right text-xs">
        <div className="flex justify-end gap-3">
          <button disabled={busy} onClick={scanThis} className="text-zinc-600 hover:underline dark:text-zinc-400">
            Scan
          </button>
          <button disabled={busy} onClick={toggleActive} className="text-zinc-600 hover:underline dark:text-zinc-400">
            {company.is_active ? "Pause" : "Resume"}
          </button>
          <button
            onClick={() => setShowIntel((v) => !v)}
            aria-expanded={showIntel}
            className="text-secondary hover:underline"
          >
            {showIntel ? "Hide details" : "Details"}
          </button>
          <button disabled={busy} onClick={remove} className="text-red-600 hover:underline">
            Delete
          </button>
        </div>
      </td>
    </tr>
  );

  return (
    <>
      {row}
      {showIntel && (
        <tr>
          <td colSpan={4} className="p-0">
            <CompanyIntelligence companyId={company.id} candidateId={candidateId} />
          </td>
        </tr>
      )}
    </>
  );
}

export default function CompaniesPage() {
  const [companies, setCompanies] = useState<Company[]>([]);
  /* The table rendered every company — ~2,500 rows and 75,169 DOM nodes on the measured dataset.
   * Same render-cap vocabulary as the jobs list and the ATS table; a search narrows the set rather
   * than forcing the cap upward. */
  const [limit, setLimit] = useState(COMPANY_LIMIT);
  /* Seeded from ?q= so the command bar can hand off a company search instead of dead-ending at an
   * unfiltered list. Read once on mount; the field is the source of truth afterwards. */
  const [query, setQuery] = useState(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("q") ?? "";
  });

  const [loading, setLoading] = useState(true);

  const filteredCompanies = query.trim()
    ? companies.filter((c) => c.name.toLowerCase().includes(query.trim().toLowerCase()))
    : companies;
  const shownCompanies = filteredCompanies.slice(0, limit);
  const hiddenCompanies = filteredCompanies.length - shownCompanies.length;

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/companies");
      const data = await res.json();
      setCompanies(data.companies ?? []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Intentional: fetch-on-mount with a loading flag, not a render loop.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Companies & career links"
        description="Every configured source JobHunt scans. Health and scan history live in ATS Operations."
      />

      <div className="space-y-2">
        <AddCompanyForm onAdded={load} />
        <AdvancedManualForm onAdded={load} />
      </div>

      {!loading && <UnsupportedSourcesSection companies={companies} onChanged={load} />}

      {loading ? (
        <>
          <LoadingRegion label="Loading companies" />
          <Surface level="z3" className="rounded-[var(--radius-xl)] p-5">
            <SkeletonRows rows={8} />
          </Surface>
        </>
      ) : companies.length === 0 ? (
        <Surface level="z3" className="rounded-[var(--radius-xl)] px-6 py-12 text-center">
          <p className="text-[13px] font-medium text-primary">No companies yet</p>
          <p className="mt-1 text-[12px] text-tertiary">Add one above to start scanning.</p>
        </Surface>
      ) : (
        <Surface level="z3" className="overflow-hidden rounded-[var(--radius-xl)]">
          <div className="border-b border-[var(--separator)] px-3 py-2">
            <label className="block">
              <span className="sr-only">Filter companies by name</span>
              <input
                type="search"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setLimit(COMPANY_LIMIT);
                }}
                placeholder={`Filter ${companies.length.toLocaleString()} companies…`}
                className="w-full rounded-[9px] bg-[var(--well-bg)] px-3 py-1.5 text-[12.5px] text-primary shadow-[var(--well-edge)] outline-none transition-shadow duration-150 ease-out placeholder:text-tertiary focus:shadow-[var(--well-edge),0_0_0_2px_var(--accent-soft)]"
              />
            </label>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[12.5px]">
              <thead>
                <tr className="border-b border-[var(--separator)]">
                  {["Company", "H1B confidence", "Last scan", ""].map((h, i) => (
                    <th
                      key={i}
                      className="whitespace-nowrap px-3 py-2 text-[9.5px] font-semibold uppercase tracking-[0.09em] text-tertiary"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shownCompanies.map((c) => (
                  <CompanyRow key={c.id} company={c} onChanged={load} />
                ))}
              </tbody>
            </table>
          </div>
          {hiddenCompanies > 0 && (
            <div className="flex items-center justify-between gap-3 border-t border-[var(--separator)] px-3 py-2">
              <span className="text-[11.5px] tabular-nums text-tertiary">
                Showing {shownCompanies.length.toLocaleString()} of {filteredCompanies.length.toLocaleString()}
              </span>
              <button
                type="button"
                onClick={() => setLimit((n) => n + COMPANY_STEP)}
                className="shrink-0 rounded-md px-2 py-1 text-[11.5px] font-medium text-secondary transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] hover:text-primary active:scale-[0.98]"
              >
                Show {Math.min(COMPANY_STEP, hiddenCompanies).toLocaleString()} more
              </button>
            </div>
          )}
        </Surface>
      )}
    </div>
  );
}
