"use client";

import { useEffect, useState } from "react";
import { H1bBadge } from "@/components/H1bBadge";
import type { Company, SourceType } from "@/types";

const ATS_SOURCES: { value: SourceType; label: string; placeholder: string }[] = [
  { value: "greenhouse", label: "Greenhouse", placeholder: "board token, e.g. gitlab" },
  { value: "ashby", label: "Ashby", placeholder: "board name, e.g. linear" },
  { value: "lever", label: "Lever", placeholder: "company slug, e.g. palantir" },
];

function AtsCompanyForm({ onAdded }: { onAdded: () => void }) {
  const [name, setName] = useState("");
  const [sourceType, setSourceType] = useState<SourceType>("greenhouse");
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

  const current = ATS_SOURCES.find((s) => s.value === sourceType)!;

  return (
    <form onSubmit={submit} className="space-y-3 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="text-sm font-semibold">Add ATS company</h2>
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
          onChange={(e) => setSourceType(e.target.value as SourceType)}
          className="rounded border border-zinc-300 px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
        >
          {ATS_SOURCES.map((s) => (
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
          className="min-w-[180px] flex-1 rounded border border-zinc-300 px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
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

function CareerLinkForm({ onAdded }: { onAdded: () => void }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
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
        body: JSON.stringify({ name, source_type: "career_link", career_page_url: url }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(JSON.stringify(data.error));
      }
      setName("");
      setUrl("");
      onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add career link");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="text-sm font-semibold">Add career page link</h2>
      <p className="text-xs text-zinc-500">
        For companies without a Greenhouse/Ashby/Lever board. Scraped best-effort via a headless
        browser — link/title only, no job descriptions, and it won&apos;t auto-close postings.
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

      <div className="grid gap-4 md:grid-cols-2">
        <AtsCompanyForm onAdded={load} />
        <CareerLinkForm onAdded={load} />
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
