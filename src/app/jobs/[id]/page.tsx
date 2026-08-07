"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { use } from "react";
import { H1bBadge } from "@/components/H1bBadge";
import { PipelineStatusSelect } from "@/components/PipelineStatusSelect";
import { sanitizeJobHtml } from "@/lib/sanitizeHtml";
import type { DescriptionSections, JobWithCompany } from "@/types";

interface JobDetailResponse {
  job: JobWithCompany;
  generatedFiles: string[];
}

const SECTION_LABELS: Record<keyof DescriptionSections, string> = {
  responsibilities: "Responsibilities",
  qualifications: "Qualifications",
  niceToHave: "Nice to have",
  skills: "Skills",
  benefits: "Benefits",
};

function parseSections(json: string | null): DescriptionSections | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as DescriptionSections;
  } catch {
    return null;
  }
}

function TailoringToggle({ jobId, initial }: { jobId: number; initial: boolean }) {
  const [checked, setChecked] = useState(initial);
  const [saving, setSaving] = useState(false);

  async function toggle() {
    const next = !checked;
    setChecked(next);
    setSaving(true);
    try {
      await fetch(`/api/jobs/${jobId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markedForTailoring: next }),
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={checked} disabled={saving} onChange={toggle} className="h-4 w-4" />
      Marked for resume tailoring
    </label>
  );
}

function CopyPromptButton({ job }: { job: JobWithCompany }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    const prompt = `/tailor-resume job=${job.id}`;
    await navigator.clipboard.writeText(prompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <button
      onClick={copy}
      className="rounded border border-zinc-300 px-3 py-1.5 text-xs font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
    >
      {copied ? "Copied!" : "Copy Claude Code prompt"}
    </button>
  );
}

export default function JobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = useState<JobDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`/api/jobs/${id}`);
      if (res.status === 404) {
        setNotFound(true);
        return;
      }
      const json = (await res.json()) as JobDetailResponse;
      setData(json);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Intentional: fetch-on-mount/id-change with a loading flag, not a render loop.
    // `load` is intentionally omitted below — it's redefined every render and doesn't depend on
    // anything but `id`, which is already the effect's dependency.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (loading) return <p className="text-sm text-zinc-500">Loading…</p>;
  if (notFound || !data) return <p className="text-sm text-zinc-500">Job not found.</p>;

  const { job, generatedFiles } = data;
  const sections = parseSections(job.description_sections);
  const facts = [
    job.location,
    job.employment_type,
    job.workplace_type,
    job.salary_text,
  ].filter(Boolean);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/jobs" className="text-xs text-zinc-500 hover:underline">
          ← Back to jobs
        </Link>
        <div className="mt-1 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">{job.title}</h1>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              {job.company_name} · {job.source_type}
              {!job.is_active && " · closed"}
            </p>
            {facts.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {facts.map((fact, i) => (
                  <span
                    key={i}
                    className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
                  >
                    {fact}
                  </span>
                ))}
              </div>
            )}
          </div>
          <a
            href={job.url}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
          >
            View posting ↗
          </a>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-4">
          {sections && (
            <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
              <h2 className="mb-3 text-sm font-semibold">At a glance</h2>
              <p className="mb-3 text-xs text-zinc-500">
                Best-effort extraction from the full description below — always verify against it.
              </p>
              <div className="space-y-3">
                {(Object.keys(SECTION_LABELS) as (keyof DescriptionSections)[])
                  .filter((key) => sections[key])
                  .map((key) => (
                    <div key={key}>
                      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                        {SECTION_LABELS[key]}
                      </h3>
                      <p className="whitespace-pre-line text-sm text-zinc-700 dark:text-zinc-300">
                        {sections[key]}
                      </p>
                    </div>
                  ))}
              </div>
            </div>
          )}

          <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="mb-2 text-sm font-semibold">Full description</h2>
            {job.description_html ? (
              <div
                className="prose prose-sm dark:prose-invert max-w-none text-sm"
                dangerouslySetInnerHTML={{ __html: sanitizeJobHtml(job.description_html) }}
              />
            ) : job.description_text ? (
              <p className="whitespace-pre-line text-sm text-zinc-700 dark:text-zinc-300">
                {job.description_text}
              </p>
            ) : (
              <p className="text-sm text-zinc-500">
                No description text captured for this posting (common for career-link scrapes, since
                that scraper only extracts links/titles). View the original posting for details, or
                add this company as a proper Greenhouse/Ashby/Lever entry on the Companies page if
                available — see the note there if one was auto-detected.
              </p>
            )}
          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="mb-3 text-sm font-semibold">Pipeline</h2>
            <div className="space-y-3">
              <div>
                <div className="mb-1 text-xs text-zinc-500">Status</div>
                <PipelineStatusSelect jobId={job.id} value={job.pipeline_status} />
              </div>
              <TailoringToggle jobId={job.id} initial={job.marked_for_tailoring === 1} />
            </div>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="mb-2 text-sm font-semibold">H1B signal</h2>
            <div className="mb-2">
              <H1bBadge signal={job.h1b_combined_signal} />
            </div>
            <ul className="space-y-1 text-xs text-zinc-600 dark:text-zinc-400">
              <li>
                Posting text sponsorship mention:{" "}
                {job.sponsorship_mentioned ? job.sponsorship_polarity : "none found"}
              </li>
              <li>Combined signal: {job.h1b_combined_signal}</li>
            </ul>
            {job.sponsorship_snippet && (
              <blockquote className="mt-2 rounded border-l-2 border-zinc-300 bg-zinc-50 px-2 py-1.5 text-xs italic text-zinc-600 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-400">
                &ldquo;{job.sponsorship_snippet}&rdquo;
              </blockquote>
            )}
            <p className="mt-2 text-xs text-zinc-500">
              Company-level signal comes from DOL H1B LCA history; posting text can override it up
              (&quot;Likely&quot;) or down (&quot;Unlikely&quot;). See the Companies page for the
              underlying match.
            </p>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="mb-2 text-sm font-semibold">Resume tailoring</h2>
            <p className="mb-3 text-xs text-zinc-500">
              Tailoring runs in Claude Code, not this app. Mark this job for tailoring, then in a
              Claude Code session in this project run the skill below.
            </p>
            <CopyPromptButton job={job} />
            <div className="mt-3">
              <div className="mb-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">
                Generated files ({generatedFiles.length})
              </div>
              {generatedFiles.length === 0 ? (
                <p className="text-xs text-zinc-500">None yet.</p>
              ) : (
                <ul className="space-y-0.5 text-xs">
                  {generatedFiles.map((f) => (
                    <li key={f} className="font-mono text-zinc-600 dark:text-zinc-400">
                      {f}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
