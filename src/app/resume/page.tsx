"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import type { ResumeLibraryEntry } from "@/app/api/candidates/[candidateId]/resume-library/route";
import {
  BTN_PRIMARY,
  BTN_QUIET,
  BTN_SECONDARY,
  INPUT,
  LoadingRegion,
  PageHeader,
  Panel,
  PanelEmpty,
  Pill,
  SkeletonRows,
} from "@/components/ui";
import {
  IconArrowUpRight,
  IconCheckCircle,
  IconDocument,
  IconSearch,
  IconShield,
  IconSparkle,
  IconStar,
} from "@/components/icons";
import { useResolvedCandidateId } from "@/lib/useActiveCandidateId";
import { ResumePreview } from "./ResumePreview";
import {
  RESUME_STUDIO_EMPTY_COPY,
  RESUME_STUDIO_TABS,
  presentResumeStudioEntry,
  type ResumeStudioAction,
  type ResumeStudioPresentation,
  type ResumeStudioTab,
} from "./resumeStudioPresentation";

interface Manifest {
  resume?: { filename: string; uploadedAt: string; sizeBytes: number };
  skills?: { filename: string; uploadedAt: string; sizeBytes: number };
}

interface PresentedEntry {
  entry: ResumeLibraryEntry;
  presentation: ResumeStudioPresentation;
}

function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function initials(name: string | null): string {
  if (!name) return "?";
  const words = name.replace(/[^A-Za-z0-9 ]/g, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

export default function ResumeStudioPage() {
  const candidateId = useResolvedCandidateId();
  const [entries, setEntries] = useState<ResumeLibraryEntry[] | null>(null);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [skillCount, setSkillCount] = useState<number | null>(null);
  const [error, setError] = useState(false);
  const [tab, setTab] = useState<ResumeStudioTab>("all");
  const [search, setSearch] = useState("");
  const [openKey, setOpenKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (candidateId === null) return;
    setError(false);
    try {
      // Three bounded page-level reads. Resume and cover-letter bodies remain lazy in ResumePreview.
      const [libraryResponse, manifestResponse, profileResponse] = await Promise.all([
        fetch(`/api/candidates/${candidateId}/resume-library`),
        fetch(`/api/master-files?candidateId=${candidateId}`),
        fetch(`/api/candidates/${candidateId}/profile`),
      ]);
      if (!libraryResponse.ok) return setError(true);
      const [libraryBody, manifestBody, profileBody] = await Promise.all([
        libraryResponse.json(),
        manifestResponse.ok ? manifestResponse.json() : null,
        profileResponse.ok ? profileResponse.json() : null,
      ]);
      setEntries(libraryBody.entries ?? []);
      setManifest(manifestBody?.manifest ?? {});
      setSkillCount(profileBody?.status === "ok" ? (profileBody.profile.skills?.length ?? null) : null);
    } catch {
      setError(true);
    }
  }, [candidateId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const rows = useMemo<PresentedEntry[]>(
    () => (entries ?? []).map((entry) => ({ entry, presentation: presentResumeStudioEntry(entry) })),
    [entries]
  );

  const counts = useMemo(() => {
    const next: Record<ResumeStudioTab, number> = {
      all: rows.length,
      ready: 0,
      tailoring: 0,
      "needs-review": 0,
      blocked: 0,
    };
    for (const row of rows) {
      if (row.presentation.bucket) next[row.presentation.bucket] += 1;
    }
    return next;
  }, [rows]);

  const attentionCount = useMemo(
    () => rows.filter((row) => row.presentation.needsAttention).length,
    [rows]
  );

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return rows.filter(({ entry, presentation }) => {
      if (tab !== "all" && presentation.bucket !== tab) return false;
      if (!query) return true;
      return `${entry.title ?? ""} ${entry.company ?? ""}`.toLowerCase().includes(query);
    });
  }, [rows, search, tab]);

  if (error) {
    return (
      <div className="mx-auto flex w-full max-w-[var(--candidate-page-max)] flex-col gap-6">
        <PageHeader size="lg" title="Resume Studio" />
        <Panel>
          <PanelEmpty action={<button type="button" onClick={load} className={`${BTN_SECONDARY} min-h-11`}>Retry</button>}>
            We couldn&apos;t load Resume Studio.
          </PanelEmpty>
        </Panel>
      </div>
    );
  }

  if (candidateId === null || entries === null) {
    return (
      <div className="mx-auto flex w-full max-w-[var(--candidate-page-max)] flex-col gap-5">
        <PageHeader
          size="lg"
          title="Resume Studio"
          description="Manage your master resume, tailored versions, and validation status."
        />
        <LoadingRegion label="Loading Resume Studio" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3].map((index) => <Panel key={index} compact><SkeletonRows rows={2} /></Panel>)}
        </div>
        <Panel><SkeletonRows rows={4} /></Panel>
      </div>
    );
  }

  const hasMasterResume = Boolean(manifest?.resume);
  const hasSkillsInventory = Boolean(manifest?.skills);

  return (
    <div className="mx-auto flex w-full max-w-[var(--candidate-page-max)] flex-col gap-6 pb-12">
      <PageHeader
        size="lg"
        title="Resume Studio"
        description="Manage your master resume, tailored versions, and validation status."
        actions={<Link href="/jobs" className={`${BTN_PRIMARY} min-h-11`}>Browse jobs</Link>}
      />

      <section aria-label="Resume overview" className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <SummaryTile
          icon={<IconDocument size={22} />}
          tone="green"
          title="Master Resume"
          value={hasMasterResume ? "Available" : "Missing"}
          detail={manifest?.resume ? `Updated ${formatDate(manifest.resume.uploadedAt) ?? "recently"}` : "Add your source resume"}
          href="/master-files"
          actionLabel={hasMasterResume ? "View resume" : "Add resume"}
        />
        <SummaryTile
          icon={<IconSparkle size={22} />}
          tone="lavender"
          title="Master Skills Inventory"
          value={hasSkillsInventory ? (skillCount === null ? "Available" : `${skillCount} verified skills`) : "Missing"}
          detail={manifest?.skills ? `Updated ${formatDate(manifest.skills.uploadedAt) ?? "recently"}` : "Add verified evidence"}
          href={hasSkillsInventory ? "/profile" : "/master-files"}
          actionLabel={hasSkillsInventory ? "View skills" : "Add inventory"}
        />
        <SummaryTile
          icon={<IconCheckCircle size={22} />}
          tone="blue"
          title="Ready to use"
          value={String(counts.ready)}
          detail="Cleared for human application"
          onClick={() => setTab("ready")}
          actionLabel="View ready"
        />
        <SummaryTile
          icon={<IconStar size={22} />}
          tone="amber"
          title="Needs attention"
          value={String(attentionCount)}
          detail={attentionCount === 0 ? "Nothing needs action" : "Highlighted in the list below"}
        />
      </section>

      <section aria-labelledby="tailored-resumes-title" className="overflow-hidden rounded-[18px] border border-[var(--border)] bg-[var(--z3-bg)] shadow-[var(--lift-1)]">
        <div className="flex flex-col gap-5 border-b border-[var(--separator)] px-4 py-5 sm:px-6 lg:flex-row lg:items-end lg:justify-between lg:px-7">
          <div>
            <p className="text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--accent)]">Your resume workspace</p>
            <h2 id="tailored-resumes-title" className="mt-1 text-[22px] font-bold tracking-[-0.02em] text-primary">Tailored resumes</h2>
            <p className="mt-1 text-[14px] leading-6 text-secondary">See what is ready, what is moving, and what needs you next.</p>
          </div>
          <label className="relative block w-full lg:w-[320px]">
            <span className="sr-only">Search tailored resumes by company or role</span>
            <span aria-hidden="true" className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-tertiary"><IconSearch size={18} /></span>
            <input
              type="search"
              className={`${INPUT} min-h-11 pl-11 text-[14px]`}
              placeholder="Search role or company"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
        </div>

        <div className="border-b border-[var(--separator)] px-2 sm:px-4">
          <div role="tablist" aria-label="Resume status" className="flex min-w-max gap-1 overflow-x-auto py-2">
            {RESUME_STUDIO_TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={tab === item.id}
                onClick={() => setTab(item.id)}
                className={`premium-active-tab inline-flex min-h-11 shrink-0 items-center gap-2 rounded-[11px] px-4 text-[14px] font-semibold transition-colors duration-150 ${tab === item.id ? "bg-[var(--accent)] text-[var(--accent-fg)]" : "text-secondary hover:bg-[var(--surface-hover)] hover:text-primary"}`}
              >
                {item.label}
                <span className={`tabular-nums ${tab === item.id ? "opacity-80" : "text-tertiary"}`}>{counts[item.id]}</span>
              </button>
            ))}
          </div>
        </div>

        {rows.length === 0 ? (
          <ResumeEmpty copy={RESUME_STUDIO_EMPTY_COPY.all} showBrowseJobs />
        ) : visible.length === 0 ? (
          <ResumeEmpty copy={search.trim() ? `No resume matches “${search.trim()}”.` : RESUME_STUDIO_EMPTY_COPY[tab]} />
        ) : (
          <ul className="grid gap-3 bg-[var(--surface-muted)] p-3 sm:p-4 lg:p-5">
            {visible.map(({ entry, presentation }) => (
              <ResumeCard
                key={entry.dedupeKey}
                entry={entry}
                presentation={presentation}
                candidateId={candidateId}
                open={openKey === entry.dedupeKey}
                onToggle={() => setOpenKey(openKey === entry.dedupeKey ? null : entry.dedupeKey)}
                onRevalidated={load}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function SummaryTile({
  icon,
  tone,
  title,
  value,
  detail,
  href,
  onClick,
  actionLabel,
}: {
  icon: ReactNode;
  tone: "green" | "lavender" | "blue" | "amber";
  title: string;
  value: string;
  detail: string;
  href?: string;
  onClick?: () => void;
  actionLabel?: string;
}) {
  const tones = {
    green: "bg-[var(--tile-green-bg)] text-[var(--tile-green-fg)]",
    lavender: "bg-[var(--tile-lav-bg)] text-[var(--tile-lav-fg)]",
    blue: "bg-[var(--tile-blue-bg)] text-[var(--tile-blue-fg)]",
    amber: "bg-[var(--tile-amber-bg)] text-[var(--tile-amber-fg)]",
  };
  const actionClass = "inline-flex min-h-11 items-center gap-1.5 text-[14px] font-semibold text-[var(--accent)] transition-colors hover:text-[var(--accent-hover)]";
  return (
    <article className="premium-hover-lift flex min-h-[168px] flex-col rounded-[16px] border border-[var(--border)] bg-[var(--z3-bg)] p-4 shadow-[var(--lift-1)] sm:rounded-[18px] sm:p-5">
      <div className={`grid h-10 w-10 place-items-center rounded-[12px] sm:h-11 sm:w-11 sm:rounded-[13px] ${tones[tone]}`}>{icon}</div>
      <h2 className="mt-3 text-[14px] font-semibold leading-5 text-secondary sm:mt-4 sm:text-[15px]">{title}</h2>
      <div className="mt-1 text-[22px] font-bold leading-7 tracking-[-0.02em] text-primary sm:text-[25px]">{value}</div>
      <p className="mt-1 text-[13px] leading-5 text-tertiary sm:text-[14px]">{detail}</p>
      <div className="mt-auto pt-2">
        {href && actionLabel ? (
          <Link href={href} className={actionClass}>{actionLabel}<IconArrowUpRight size={14} /></Link>
        ) : onClick && actionLabel ? (
          <button type="button" onClick={onClick} className={actionClass}>{actionLabel}<IconArrowUpRight size={14} /></button>
        ) : null}
      </div>
    </article>
  );
}

function ResumeEmpty({ copy, showBrowseJobs = false }: { copy: string; showBrowseJobs?: boolean }) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center sm:py-16">
      <span aria-hidden="true" className="grid h-14 w-14 place-items-center rounded-[17px] bg-[var(--tile-lav-bg)] text-[var(--tile-lav-fg)]"><IconDocument size={25} /></span>
      <h3 className="mt-4 text-[17px] font-bold text-primary">{copy}</h3>
      <p className="mt-1.5 max-w-[46ch] text-[14px] leading-6 text-secondary">Resume Studio will keep each tailored version and its next step together.</p>
      {showBrowseJobs && <Link href="/jobs" className={`${BTN_PRIMARY} mt-5 min-h-11`}>Browse jobs</Link>}
    </div>
  );
}

function ResumeCard({
  entry,
  presentation,
  candidateId,
  open,
  onToggle,
  onRevalidated,
}: {
  entry: ResumeLibraryEntry;
  presentation: ResumeStudioPresentation;
  candidateId: number;
  open: boolean;
  onToggle: () => void;
  onRevalidated: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const detailId = `resume-detail-${entry.workflowId}`;
  const canPreview = entry.jobId !== null && (entry.documents.resume || entry.documents.coverLetter);

  async function revalidate() {
    if (entry.jobId === null || !entry.canRevalidate) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/candidates/${candidateId}/jobs/${entry.jobId}/quality-workflow/revalidate`, { method: "POST" });
      if (!response.ok) throw new Error("We couldn't re-run validation. Nothing changed.");
      setMessage("Validation finished. Status refreshed.");
      await onRevalidated();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "We couldn't re-run validation.");
    } finally {
      setBusy(false);
    }
  }

  const artifact = (document: "resume" | "coverLetter") =>
    `/api/candidates/${candidateId}/jobs/${entry.jobId}/quality-workflow/artifacts/${document}`;

  return (
    <li className={`premium-hover-lift overflow-hidden rounded-[16px] border bg-[var(--z3-bg)] shadow-[var(--lift-1)] ${presentation.bucket === "blocked" ? "border-[color-mix(in_srgb,var(--error)_24%,var(--border))]" : presentation.needsAttention ? "border-[color-mix(in_srgb,var(--warning)_24%,var(--border))]" : "border-[var(--border)]"}`}>
      <div className="grid gap-4 p-4 sm:p-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(180px,.75fr)_auto] lg:items-center lg:gap-6 lg:p-6">
        <div className="flex min-w-0 items-start gap-3.5 sm:gap-4">
          <span aria-hidden="true" className="grid h-12 w-12 shrink-0 place-items-center rounded-[14px] bg-[var(--tile-lav-bg)] text-[14px] font-bold text-[var(--tile-lav-fg)] sm:h-14 sm:w-14">{initials(entry.company)}</span>
          <div className="min-w-0">
            <h3 className="text-[17px] font-bold leading-[1.35] tracking-[-0.01em] text-primary sm:text-[18px]">{entry.title ?? "Tailored resume"}</h3>
            <p className="mt-1 text-[14px] font-medium text-secondary">{entry.company ?? "Job no longer listed"}</p>
            <p className="mt-1 text-[13px] leading-5 text-tertiary">Updated {formatDate(entry.updatedAt) ?? "date unavailable"}{entry.iteration > 1 ? ` · Version ${entry.iteration}` : ""}</p>
          </div>
        </div>

        <div className="flex min-w-0 items-center gap-3 lg:block">
          <Pill tone={presentation.status.tone}>{presentation.label}</Pill>
          {entry.overallScore !== null && <p className="text-[13px] text-tertiary lg:mt-2">Review score <span className="font-semibold tabular-nums text-primary">{entry.overallScore}</span>/100</p>}
        </div>

        <div className="flex flex-wrap items-center gap-2 lg:justify-end">
          <PrimaryAction
            action={presentation.action}
            busy={busy}
            onOpen={() => setPreviewing(true)}
            onRevalidate={revalidate}
            onDetails={onToggle}
          />
          {presentation.action.kind !== "details" && (
            <button type="button" onClick={onToggle} aria-expanded={open} aria-controls={detailId} className={`${BTN_QUIET} min-h-11`}>{open ? "Hide details" : "Details"}</button>
          )}
        </div>
      </div>

      {open && (
        <div id={detailId} className="premium-expansion grid gap-4 border-t border-[var(--separator)] bg-[var(--surface-muted)] p-4 sm:p-5 lg:grid-cols-[minmax(0,1fr)_310px] lg:p-6">
          <div className="rounded-[13px] border border-[var(--border)] bg-[var(--z3-bg)] p-4">
            <div className="flex flex-wrap items-center gap-2"><IconShield size={17} /><span className="text-[14px] font-bold text-primary">Validation</span><Pill tone={presentation.status.tone}>{presentation.label}</Pill></div>
            <p className="mt-3 max-w-[72ch] text-[14px] leading-6 text-secondary">{entry.blockingReason ?? presentation.status.hint ?? "No additional validation detail is available."}</p>
            {!presentation.status.sendable && <p className="mt-2 text-[13px] leading-5 text-tertiary">This version is not cleared for application yet.</p>}
            {message && <p aria-live="polite" className="mt-3 text-[13px] font-medium text-secondary">{message}</p>}
          </div>

          <div className="rounded-[13px] border border-[var(--border)] bg-[var(--z3-bg)] p-4">
            <div className="flex flex-wrap items-center gap-2"><IconDocument size={17} /><span className="text-[14px] font-bold text-primary">Documents</span>{entry.documents.packageKind === "best-attempt" && <Pill tone="warning">Best attempt</Pill>}</div>
            {!entry.documents.resume && !entry.documents.coverLetter ? (
              <p className="mt-3 text-[14px] leading-6 text-tertiary">No documents are available for this version.</p>
            ) : (
              <ul className="mt-3 grid gap-2">
                {entry.documents.resume && <DocumentRow label="Resume" href={entry.jobId !== null ? artifact("resume") : null} onView={canPreview ? () => setPreviewing(true) : null} />}
                {entry.documents.coverLetter && <DocumentRow label="Cover letter" href={entry.jobId !== null ? artifact("coverLetter") : null} onView={canPreview ? () => setPreviewing(true) : null} />}
              </ul>
            )}
          </div>
        </div>
      )}

      {previewing && entry.jobId !== null && (
        <ResumePreview
          candidateId={candidateId}
          jobId={entry.jobId}
          company={entry.company}
          role={entry.title}
          hasCoverLetter={entry.documents.coverLetter}
          downloadHref={(document) => artifact(document)}
          onClose={() => setPreviewing(false)}
        />
      )}
    </li>
  );
}

function PrimaryAction({
  action,
  busy,
  onOpen,
  onRevalidate,
  onDetails,
}: {
  action: ResumeStudioAction;
  busy: boolean;
  onOpen: () => void;
  onRevalidate: () => void;
  onDetails: () => void;
}) {
  const className = `${BTN_PRIMARY} min-h-11 w-full sm:w-auto`;
  if (action.href) return <Link href={action.href} className={className}>{action.label}<IconArrowUpRight size={15} /></Link>;
  if (action.kind === "open") return <button type="button" onClick={onOpen} className={className}>{action.label}</button>;
  if (action.kind === "revalidate") return <button type="button" onClick={onRevalidate} disabled={busy} className={className}>{busy ? "Re-running…" : action.label}</button>;
  return <button type="button" onClick={onDetails} className={className}>{action.label}</button>;
}

function DocumentRow({ label, href, onView }: { label: string; href: string | null; onView: (() => void) | null }) {
  return (
    <li className="flex min-h-11 items-center justify-between gap-3 rounded-[10px] bg-[var(--z0-bg)] px-3">
      <span className="text-[13.5px] font-medium text-primary">{label}</span>
      <span className="flex items-center gap-3">
        {onView && <button type="button" onClick={onView} className="min-h-11 text-[13px] font-semibold text-[var(--accent)]">View</button>}
        {href && <a href={href} className="inline-flex min-h-11 items-center text-[13px] font-semibold text-secondary">Download</a>}
      </span>
    </li>
  );
}
