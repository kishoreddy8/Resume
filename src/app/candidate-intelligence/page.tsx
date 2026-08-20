"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { announceBuildStarted } from "@/lib/buildEvents";
import { useActiveCandidateId } from "@/lib/useActiveCandidateId";
import {
  LoadingRegion,
  Metric,
  PageHeader,
  SkeletonRows,
  StatusDot,
  Surface,
} from "@/components/ui";
import { BuildingProfile } from "@/components/BuildingProfile";
import { shortFailure } from "@/app/onboarding/stageModel";

/**
 * Candidate Intelligence Center.
 *
 * Everything here is read from the derived candidate profile — the same file Phase 2 matching uses —
 * plus a count of how often each skill appears in the scanned job corpus. Nothing is scored,
 * ranked, or inferred on this page.
 *
 * THREE THINGS THIS PAGE REFUSES TO DO:
 *
 * 1. It never says "market demand". There is no labour-market dataset in Career-Ops. The frequency
 *    column counts THIS instance's scraped postings, which is shaped by which companies are
 *    configured and how long the scanner has run. It is labelled a search signal and states its
 *    denominator everywhere it appears.
 *
 * 2. It never says a skill is "missing". The comparison below is an exact, case-insensitive NAME
 *    match, while the real matching engine resolves aliases through SKILL_TAXONOMY. So a corpus
 *    skill with no name match here may still be matched by the engine. Calling that a gap would
 *    manufacture a weakness out of a naming difference, so those rows say "no name match" and the
 *    caveat is printed next to them.
 *
 * 3. It renders nothing at all from a stale profile. `loadCandidateProfile` reports stale when the
 *    master resume has changed since the profile was built; showing evidence from a superseded
 *    resume is exactly the failure the freshness check exists to prevent.
 */

interface SkillEntry {
  rawSkillName: string;
  source: "employer" | "inventory_only";
  attributedTo?: { employer: string; project?: string }[];
  yearsStated?: number;
}
interface ExperienceEntry {
  employer: string;
  title: string;
  startDate: string | null;
  endDate: string | null;
  technologies: string[];
}
interface ProfileResponse {
  status: "ok" | "missing" | "stale" | "invalid";
  error: string | null;
  profile: {
    builtAt: string;
    skills: SkillEntry[];
    experience: ExperienceEntry[];
    education: { level: string; field: string | null; institution: string | null }[];
    certifications: { name: string; issuer?: string }[];
    totalYearsExperience: number | null;
  } | null;
  signal: { skillName: string; jobCount: number; requiredCount: number }[];
  corpusJobs: number;
}

function formatSpan(start: string | null, end: string | null): string {
  const fmt = (v: string | null) => {
    if (!v) return null;
    const d = new Date(`${v.length === 7 ? `${v}-01` : v}T00:00:00Z`);
    return Number.isNaN(d.getTime())
      ? v
      : d.toLocaleDateString(undefined, { month: "short", year: "numeric", timeZone: "UTC" });
  };
  const s = fmt(start);
  if (!s) return end ? `until ${fmt(end)}` : "Dates not stated";
  return `${s} — ${end ? fmt(end) : "Present"}`;
}

export default function CandidateIntelligencePage() {
  const candidateId = useActiveCandidateId();
  const [data, setData] = useState<ProfileResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [building, setBuilding] = useState(false);
  const [buildPhase, setBuildPhase] = useState<string | null>(null);
  const [buildError, setBuildError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const res = await fetch(`/api/candidates/${candidateId}/profile`);
        if (!res.ok) return;
        const body = (await res.json()) as ProfileResponse;
        if (!cancelled) setData(body);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [candidateId]);

  /* Build from here too. This page was the dead end the user actually hit: it stated the profile
   * was not built and named a command, with no way to act. Same failure shape as the PIN prompt —
   * telling someone what to do while giving them no way to do it. */
  /* Follows a build this page started — or one already running when the page loaded, since the
   * registry is server-side and a build begun on the setup page is visible from here too. */
  useEffect(() => {
    if (!building) return;
    let cancelled = false;
    const id = setInterval(async () => {
      try {
        const res = await fetch(`/api/candidates/${candidateId}/build-profile`);
        if (!res.ok || cancelled) return;
        const body = await res.json();
        setBuildPhase(body.phase ?? null);
        if (body.status === "running") return;
        setBuilding(false);
        if (body.status === "failed") setBuildError(shortFailure(body.failureCode ?? null));
        else window.location.reload();
      } catch {
        // A dropped poll is not a failed build.
      }
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [building, candidateId]);

  /* POST starts the build and returns; the poll below follows it. Awaiting the whole run here
   * meant leaving this page abandoned a build that was in fact still going on the server. */
  async function build() {
    setBuilding(true);
    setBuildError(null);
    try {
      const res = await fetch(`/api/candidates/${candidateId}/build-profile`, { method: "POST" });
      announceBuildStarted(candidateId);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setBuildError(body.error ?? "The profile build could not be started.");
        setBuilding(false);
      }
    } catch {
      setBuildError("Could not reach the server.");
      setBuilding(false);
    }
  }

  if (loading && !data) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Candidate Intelligence" description="Your evidence-backed career model." />
        <LoadingRegion label="Loading candidate intelligence" />
        <Surface level="z3" className="rounded-[var(--radius-xl)] p-5">
          <SkeletonRows rows={7} />
        </Surface>
      </div>
    );
  }

  // A profile that is missing, stale or invalid renders its reason and nothing else.
  if (!data || data.status !== "ok" || !data.profile) {
    const reason =
      data?.status === "stale"
        ? "Your master resume or skills inventory changed after this profile was built, so the evidence below would be out of date."
        : data?.status === "missing"
          ? "No candidate profile has been built yet."
          : data?.error ?? "The candidate profile could not be read.";
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Candidate Intelligence" description="Your evidence-backed career model." />
        <Surface level="z3" className="rounded-[var(--radius-xl)] px-6 py-12 text-center">
          <p className="text-[13px] font-medium text-primary">
            Profile {data?.status === "stale" ? "is stale" : data?.status === "missing" ? "not built" : "unavailable"}
          </p>
          <p className="mx-auto mt-1.5 max-w-[54ch] text-[12px] leading-relaxed text-tertiary">{reason}</p>
          <p className="mx-auto mt-2 max-w-[54ch] text-[11.5px] leading-relaxed text-tertiary">
            Nothing is shown here from a profile that cannot be trusted. Building reads your Master
            Resume and Skills Inventory with your Claude subscription — it takes a couple of minutes.
          </p>
          {building && (
            <div className="mx-auto mt-4 max-w-[46ch] text-left">
              <BuildingProfile candidateId={candidateId} phase={buildPhase} />
            </div>
          )}
          {buildError && <p className="mt-2 text-[12px] text-[var(--error)]">{buildError}</p>}
          <div className="mt-4 flex justify-center gap-2">
            <button
              type="button"
              onClick={build}
              disabled={building}
              className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-[12.5px] font-semibold text-[var(--accent-fg)] transition-[background-color,transform] duration-150 ease-out hover:bg-[var(--accent-hover)] active:scale-[0.98] disabled:opacity-50"
            >
              {building ? "Building…" : "Build profile now"}
            </button>
            <Link
              href="/master-files"
              className="rounded-md border border-[var(--border)] px-3 py-1.5 text-[12.5px] font-medium text-secondary transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] hover:text-primary"
            >
              Master Files
            </Link>
          </div>
          <p className="mx-auto mt-3 max-w-[54ch] text-[11px] leading-relaxed text-tertiary">
            If it does not complete, run <span className="text-secondary">/build-candidate-profile {candidateId}</span>{" "}
            in Claude Code instead.
          </p>
        </Surface>
      </div>
    );
  }

  const p = data.profile;
  const employerSkills = p.skills.filter((s) => s.source === "employer");
  const inventorySkills = p.skills.filter((s) => s.source === "inventory_only");
  const current = p.experience.find((e) => e.endDate === null) ?? p.experience[0];

  // Exact, case-insensitive name match — see this file's header for why that limitation is stated
  // rather than smoothed over.
  const byName = new Map<string, SkillEntry>();
  for (const s of p.skills) byName.set(s.rawSkillName.toLowerCase(), s);

  const signalRows = data.signal.slice(0, 24).map((row) => {
    const match = byName.get(row.skillName.toLowerCase());
    return {
      ...row,
      state: match ? (match.source === "employer" ? "employer" : "inventory") : "unmatched",
      employers: match?.attributedTo?.map((a) => a.employer) ?? [],
    } as const;
  });

  const STATE_LABEL = {
    employer: "Evidenced at employer",
    inventory: "In your inventory",
    unmatched: "No name match",
  } as const;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Candidate Intelligence"
        description="Your evidence-backed career model, read from the same profile the matching engine uses. Nothing here is scored or inferred."
        actions={
          <Link
            href="/master-files"
            className="rounded-md border border-[var(--border)] px-2.5 py-1.5 text-[12px] font-medium text-secondary transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] hover:text-primary active:scale-[0.98]"
          >
            Master Files
          </Link>
        }
      />

      {/* Professional identity — the current role, stated years, and the counts behind them. */}
      <Surface level="z3" className="tint-match rounded-[var(--radius-xl)] px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <div className="text-[9.5px] font-semibold uppercase tracking-[0.11em] text-tertiary">
              Professional identity
            </div>
            <h2 className="mt-1 text-[20px] font-semibold leading-tight tracking-[-0.015em] text-primary">
              {current?.title ?? "Title not stated"}
            </h2>
            <p className="mt-1 text-[12.5px] text-secondary">
              {current ? `${current.employer} · ${formatSpan(current.startDate, current.endDate)}` : "No experience recorded"}
            </p>
          </div>
          <div className="grid shrink-0 grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-4">
            {/* null years renders an em dash — JobHunt never infers a total from employment dates. */}
            <Metric label="Years" value={p.totalYearsExperience} hint="as stated" />
            <Metric label="Employers" value={p.experience.length} />
            <Metric label="Employer-evidenced" value={employerSkills.length} tone="success" hint="skills" />
            <Metric label="Inventory only" value={inventorySkills.length} hint="skills" />
          </div>
        </div>
      </Surface>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-6">
          {/* Experience timeline. */}
          <section className="space-y-2">
            <h2 className="section-title">Experience</h2>
            <Surface level="z3" className="rounded-[var(--radius-xl)] px-5 py-4">
              <ol>
                {p.experience.map((e, i) => (
                  <li key={`${e.employer}-${i}`} className="relative border-b border-[var(--separator)] py-3 pl-5 last:border-b-0">
                    <span aria-hidden="true" className="absolute left-[3px] top-0 h-full w-px bg-[var(--separator)]" />
                    <span className="absolute left-0 top-[18px]">
                      <StatusDot tone={e.endDate === null ? "active" : "neutral"} />
                    </span>
                    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                      <span className="text-[13.5px] font-semibold tracking-[-0.008em] text-primary">{e.title}</span>
                      <span className="text-[11.5px] tabular-nums text-tertiary">{formatSpan(e.startDate, e.endDate)}</span>
                    </div>
                    <div className="mt-0.5 text-[12px] text-secondary">{e.employer}</div>
                    {e.technologies.length > 0 && (
                      <div className="mt-1.5 text-[11.5px] leading-relaxed text-tertiary">
                        {e.technologies.join(" · ")}
                      </div>
                    )}
                  </li>
                ))}
              </ol>
            </Surface>
          </section>

          {/* Search signal vs evidence. */}
          <section className="space-y-2">
            <h2 className="section-title">JobHunt search signal</h2>
            <Surface level="z3" className="rounded-[var(--radius-xl)] px-5 py-4">
              <p className="text-[11.5px] leading-relaxed text-tertiary">
                How often each skill appears across the{" "}
                <span className="tabular-nums text-secondary">{data.corpusJobs.toLocaleString()}</span> scanned postings
                that yielded structured skills.{" "}
                <span className="text-secondary">This reflects your scanned job corpus, not overall market demand.</span>
              </p>
              <div className="mt-3">
                {signalRows.map((row) => (
                  <div
                    key={row.skillName}
                    className="flex items-baseline gap-3 border-b border-[var(--separator)] py-[7px] last:border-b-0"
                  >
                    <StatusDot
                      tone={row.state === "employer" ? "ready" : row.state === "inventory" ? "attention" : "unknown"}
                      className="translate-y-[-1px]"
                    />
                    <span className="w-[9rem] shrink-0 truncate text-[12.5px] text-primary">{row.skillName}</span>
                    <span
                      className="min-w-0 flex-1 truncate text-[11px] text-tertiary"
                      title={row.employers.join(", ")}
                    >
                      {row.state === "employer" ? row.employers.join(", ") : ""}
                    </span>
                    <span className="shrink-0 text-[11px] tabular-nums text-tertiary">
                      {row.jobCount.toLocaleString()} postings
                    </span>
                    <span
                      className={`w-[10.5rem] shrink-0 text-right text-[11px] font-medium ${
                        row.state === "employer"
                          ? "text-[var(--success)]"
                          : row.state === "inventory"
                            ? "text-[var(--warning)]"
                            : "text-tertiary"
                      }`}
                    >
                      {STATE_LABEL[row.state]}
                    </span>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-[11px] leading-relaxed text-tertiary">
                “No name match” is not a gap. This compares skill names exactly; the matching engine resolves aliases
                through its taxonomy and may still credit these on a real job.
              </p>
            </Surface>
          </section>
        </div>

        <div className="flex flex-col gap-6">
          <section className="space-y-2">
            <h2 className="section-title">Education</h2>
            <Surface level="z3" className="rounded-[var(--radius-xl)] px-5 py-3">
              {p.education.map((e, i) => (
                <div key={i} className="border-b border-[var(--separator)] py-2 last:border-b-0">
                  <div className="text-[12.5px] font-medium text-primary">
                    {[e.level, e.field].filter(Boolean).join(" · ")}
                  </div>
                  {e.institution && <div className="mt-0.5 text-[11.5px] text-tertiary">{e.institution}</div>}
                </div>
              ))}
            </Surface>
          </section>

          <section className="space-y-2">
            <h2 className="section-title">Certifications</h2>
            <Surface level="z3" className="rounded-[var(--radius-xl)] px-5 py-3">
              {p.certifications.length === 0 ? (
                <p className="py-3 text-[12px] text-tertiary">None recorded.</p>
              ) : (
                p.certifications.map((c) => (
                  <div key={c.name} className="flex items-baseline gap-2 border-b border-[var(--separator)] py-2 last:border-b-0">
                    <StatusDot tone="ready" className="translate-y-[-1px]" />
                    <span className="min-w-0 flex-1 text-[12.5px] text-primary">{c.name}</span>
                  </div>
                ))
              )}
              {/* The schema stores a name and optional issuer — no expiry field exists, so none is shown. */}
              <p className="mt-2 text-[11px] leading-relaxed text-tertiary">
                Expiry dates are not recorded by the profile schema. Certifications are never inferred and are never
                added to a resume by tailoring.
              </p>
            </Surface>
          </section>

          <section className="space-y-2">
            <h2 className="section-title">Profile source</h2>
            <Surface level="z3" className="rounded-[var(--radius-xl)] px-5 py-3">
              <div className="flex items-baseline justify-between gap-3 border-b border-[var(--separator)] py-2">
                <span className="text-[12px] text-primary">Built</span>
                <span className="text-[11.5px] tabular-nums text-tertiary">
                  {new Date(p.builtAt).toLocaleString()}
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-3 py-2">
                <span className="text-[12px] text-primary">Freshness</span>
                <span className="text-[11.5px] font-medium text-[var(--success)]">Matches current master files</span>
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-tertiary">
                Tailoring history is recorded per job, not per candidate — open a job to see its resume workflow.
              </p>
            </Surface>
          </section>
        </div>
      </div>
    </div>
  );
}
