"use client";

import { useEffect, useState } from "react";
import { H1bBadge } from "@/components/H1bBadge";
import type { Company, SourceType } from "@/types";

const PROVIDER_LABELS: Record<SourceType, string> = {
  greenhouse: "Greenhouse",
  ashby: "Ashby",
  lever: "Lever",
  workday: "Workday",
  career_link: "generic career page",
};

const ADVANCED_ATS_SOURCES: { value: Exclude<SourceType, "career_link">; label: string; placeholder: string }[] = [
  { value: "greenhouse", label: "Greenhouse", placeholder: "board token, e.g. gitlab" },
  { value: "ashby", label: "Ashby", placeholder: "board name, e.g. linear" },
  { value: "lever", label: "Lever", placeholder: "company slug, e.g. palantir" },
  { value: "workday", label: "Workday", placeholder: "tenant|host|site, e.g. hp|wd5|ExternalCareerSite" },
];

function useDebouncedDetection(url: string) {
  const [detected, setDetected] = useState<SourceType | null | undefined>(undefined); // undefined = not yet checked
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (!url || !/^https?:\/\/.+\..+/.test(url)) {
      // Intentional: resetting detection state as the debounced url prop changes, not a render loop.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDetected(undefined);
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
          setDetected(data.detected ?? null);
        } else {
          setDetected(null);
        }
      } catch {
        if (!cancelled) setDetected(null);
      } finally {
        if (!cancelled) setChecking(false);
      }
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [url]);

  return { detected, checking };
}

function AddCompanyForm({ onAdded }: { onAdded: () => void }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const { detected, checking } = useDebouncedDetection(url);

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
        {!checking && detected !== undefined && detected !== null && (
          <span className="text-emerald-700 dark:text-emerald-400">
            Detected: {PROVIDER_LABELS[detected]}
          </span>
        )}
        {!checking && detected === null && (
          <span>No known ATS detected — will be added as a generic career-page scrape.</span>
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

  return (
    <tr className={company.is_active ? "" : "opacity-50"}>
      <td className="px-3 py-2">
        <div className="font-medium">{company.name}</div>
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
      <td className="px-3 py-2">
        <H1bBadge signal={company.h1b_signal} />
        {company.h1b_match_employer_name && (
          <div className="mt-0.5 text-xs text-zinc-500">
            matched &quot;{company.h1b_match_employer_name}&quot; ({company.h1b_lca_count} LCAs)
          </div>
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
          <button disabled={busy} onClick={remove} className="text-red-600 hover:underline">
            Delete
          </button>
        </div>
      </td>
    </tr>
  );
}

export default function CompaniesPage() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);

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
      <h1 className="text-lg font-semibold">Companies &amp; career links</h1>

      <div className="space-y-2">
        <AddCompanyForm onAdded={load} />
        <AdvancedManualForm onAdded={load} />
      </div>

      {loading ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : companies.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 p-10 text-center text-sm text-zinc-500 dark:border-zinc-700">
          No companies yet. Add one above to start scanning.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-zinc-100 text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
              <tr>
                <th className="px-3 py-2 font-medium">Company</th>
                <th className="px-3 py-2 font-medium">H1B signal</th>
                <th className="px-3 py-2 font-medium">Last scan</th>
                <th className="px-3 py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {companies.map((c) => (
                <CompanyRow key={c.id} company={c} onChanged={load} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
