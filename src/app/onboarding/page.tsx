"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { announceBuildStarted } from "@/lib/buildEvents";
import Link from "next/link";
import { useActiveCandidateId, useResolvedCandidateId } from "@/lib/useActiveCandidateId";
import { Surface } from "@/components/ui";
import { UploadSlot, type Manifest } from "@/components/MasterFileUpload";
import { ProtectProfilePrompt } from "@/components/ProtectProfilePrompt";
import { BuildStageRail } from "./BuildStageRail";
import { ProfileReady } from "./ProfileReady";
import { ClaudeStatus, type CliState } from "./ClaudeStatus";
import { buildStages, FAILURE_GUIDANCE } from "./stageModel";

/**
 * First-run setup: one screen to fill in, one build to watch, one optional choice at the end.
 *
 * WHY THIS PAGE EXISTS. A tester uploaded both documents, saw them listed as uploaded, and then got
 * zero matches forever with nothing explaining why. Uploading does not build the derived profile
 * the matching engine reads, and no screen said so.
 *
 * WHY IT IS ONE SCREEN. It used to be a checklist that sent people elsewhere for each item —
 * documents on /master-files, contact details buried in Settings — and coming back required
 * knowing to come back. The contact fields in particular were never found at all: they are
 * required before any resume can render, but nothing in the first-run path mentioned them.
 *
 * THE THREE PHASES.
 *   setup     the form. Everything needed to reach a first match.
 *   building  a STABLE screen. The form does not collapse or reflow underneath the user; the rail
 *             simply takes over the primary position. Every row on it is an observed event.
 *   protect   the real result, then the optional PIN, then Jobs.
 *
 * WHAT IS NEVER INVENTED. Contact details go verbatim into resume headers, so a blank field stays
 * blank. The build reads only the two uploaded documents. A result that fails the matching
 * engine's own validation is discarded and the previous profile restored. And nothing on this page
 * shows a percentage: no part of the pipeline knows what fraction of the work remains.
 */

interface Setup {
  candidateId: number;
  steps: { resume: boolean; skills: boolean; preferences: boolean; profile: boolean; evaluated: boolean };
  blockedOn: string | null;
  complete: boolean;
  profileStatus: "ok" | "missing" | "stale" | "invalid";
  profileCommand: string;
  canEvaluate: boolean;
  counts: { evaluated: number; readyForTailoring: number; needsReview: number; blocked: number };
  preferences: { primaryTargetRole: string | null; secondaryTargetRoles: string[] };
}

/** Mirrors the stored contact row. Empty string rather than null while editing, so inputs stay
 *  controlled; converted back to null on save so a cleared field reads as "not configured". */
interface Identity {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  location: string;
  linkedin: string;
  github: string;
}

const EMPTY_IDENTITY: Identity = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  location: "",
  linkedin: "",
  github: "",
};

function Field({
  label,
  hint,
  value,
  placeholder,
  onChange,
  type = "text",
  required = false,
  autoComplete,
  inputMode,
}: {
  label: string;
  hint?: string;
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
  type?: string;
  required?: boolean;
  autoComplete?: string;
  inputMode?: "text" | "tel" | "email" | "url";
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="flex items-baseline gap-1.5 text-[12px] font-medium text-secondary">
        {label}
        {/* Required is marked in WORDS, not a bare asterisk — an asterisk is a convention people
         *  have to already know, and screen readers announce it as "star". */}
        {required ? (
          <span className="text-[10px] font-normal uppercase tracking-[0.07em] text-tertiary">required</span>
        ) : (
          <span className="text-[10px] font-normal uppercase tracking-[0.07em] text-tertiary">optional</span>
        )}
      </span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        required={required}
        autoComplete={autoComplete}
        inputMode={inputMode}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-[var(--border)] bg-surface px-2.5 py-1.5 text-[16px] text-primary outline-none transition-colors duration-150 ease-out hover:border-[var(--accent)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] sm:text-[13px]"
      />
      {hint && <span className="text-[11px] leading-relaxed text-tertiary">{hint}</span>}
    </label>
  );
}

export default function OnboardingPage() {
  /* Rendering uses the immediate value; every fetch below waits for the resolved one, so this page
   * never issues a full set of candidate-scoped requests against an optimistic guess. */
  const candidateId = useActiveCandidateId();
  const resolvedId = useResolvedCandidateId();
  const router = useRouter();

  const [setup, setSetup] = useState<Setup | null>(null);
  const [manifest, setManifest] = useState<Manifest>({});
  const [identity, setIdentity] = useState<Identity>(EMPTY_IDENTITY);
  const [hasPin, setHasPin] = useState<boolean | null>(null);
  const [role, setRole] = useState("");
  const [loaded, setLoaded] = useState(false);

  const [saving, setSaving] = useState(false);
  const [savedOnce, setSavedOnce] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [buildStatus, setBuildStatus] = useState<"idle" | "running" | "done" | "failed">("idle");
  const [observed, setObserved] = useState<string[]>([]);
  const [failureCode, setFailureCode] = useState<string | null>(null);
  const [summary, setSummary] = useState<{ skills: number; experience: number; certifications: number } | null>(null);
  const [buildStartedAt, setBuildStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const [evaluating, setEvaluating] = useState(false);
  const [evaluatedCount, setEvaluatedCount] = useState(0);

  const [cli, setCli] = useState<{ state: CliState; version?: string }>({ state: "unknown" });
  const [pinDismissed, setPinDismissed] = useState(false);

  const railRef = useRef<HTMLDivElement>(null);

  const loadManifest = useCallback(async () => {
    const res = await fetch(`/api/master-files?candidateId=${candidateId}`);
    if (!res.ok) return;
    const data = await res.json();
    setManifest(data.manifest ?? {});
  }, [candidateId]);

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/candidates/${candidateId}/setup`);
    if (!res.ok) return null;
    const body = (await res.json()) as Setup;
    setSetup(body);
    if (body.preferences.primaryTargetRole) setRole(body.preferences.primaryTargetRole);
    return body;
  }, [candidateId]);

  /* Loaded once and then edited locally. Re-reading on every refresh would overwrite whatever the
   * user is part-way through typing each time a background poll landed. */
  const loadIdentity = useCallback(async () => {
    const [who, settings] = await Promise.all([
      fetch(`/api/candidates/${candidateId}`),
      fetch(`/api/candidates/${candidateId}/settings`),
    ]);
    const candidate = who.ok ? (await who.json()).candidate : null;
    const contact = settings.ok ? (await settings.json()).contact : null;
    setHasPin(candidate ? Boolean(candidate.has_pin) : null);
    setIdentity({
      firstName: candidate?.first_name ?? "",
      lastName: candidate?.last_name ?? "",
      email: contact?.email ?? "",
      phone: contact?.phone ?? "",
      location: contact?.location ?? "",
      linkedin: contact?.linkedin ?? "",
      github: contact?.github ?? "",
    });
  }, [candidateId]);

  /** Reads whatever the server already knows, so a refresh mid-build rejoins it rather than
   *  starting over or showing an idle form over a running process. */
  const syncBuild = useCallback(async () => {
    const res = await fetch(`/api/candidates/${candidateId}/build-profile`);
    if (!res.ok) return null;
    const body = await res.json();
    setBuildStatus(body.status ?? "idle");
    setObserved(Array.isArray(body.observed) ? body.observed : []);
    setFailureCode(body.failureCode ?? null);
    setSummary(body.summary ?? null);
    setBuildStartedAt(body.startedAt ?? null);
    return body;
  }, [candidateId]);

  useEffect(() => {
    if (resolvedId === null) return;
    let cancelled = false;
    (async () => {
      await Promise.all([refresh(), loadManifest(), loadIdentity(), syncBuild()]);
      if (!cancelled) setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [resolvedId, refresh, loadManifest, loadIdentity, syncBuild]);

  // Verified, not assumed: this runs `claude --version`, which costs nothing and proves the binary.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/claude-cli")
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (cancelled || !body) return;
        setCli({ state: body.state as CliState, version: body.version });
      })
      .catch(() => {
        /* Leave it unknown. Saying "unavailable" because a fetch failed would be a guess. */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Save everything, then start the build.
   *
   * Three writes, deliberately kept as three: the name lives on the candidate record, contact
   * details and the target role are separate concerns on the settings route, and that route's
   * "never one flat object" boundary is what keeps a contact edit from invalidating the match
   * cache. Collapsing them here would only move that distinction somewhere less visible.
   */
  const saveAll = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      if (identity.firstName.trim() && identity.lastName.trim()) {
        const res = await fetch(`/api/candidates/${candidateId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ firstName: identity.firstName.trim(), lastName: identity.lastName.trim() }),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Could not save your name.");
      }

      const res = await fetch(`/api/candidates/${candidateId}/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contact: {
            email: identity.email.trim() || null,
            phone: identity.phone.trim() || null,
            location: identity.location.trim() || null,
            linkedin: identity.linkedin.trim() || null,
            github: identity.github.trim() || null,
          },
          ...(role.trim() ? { preferences: { primaryTargetRole: role.trim() } } : {}),
        }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Could not save your details.");

      setSavedOnce(true);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }, [candidateId, identity, role, refresh]);

  /**
   * Start the profile build using the user's own locally authenticated Claude CLI subscription.
   *
   * POST only STARTS it — the response is 202 and the work continues server-side. If it fails, the
   * failure matrix explains what happened and what is still safe; the manual Claude Code command
   * stays available for the failures where it would actually help.
   */
  const buildProfile = useCallback(async () => {
    setFailureCode(null);
    setBuildStatus("running");
    setObserved([]);
    setBuildStartedAt(Date.now());
    try {
      const res = await fetch(`/api/candidates/${candidateId}/build-profile`, { method: "POST" });
      announceBuildStarted(candidateId);
      if (!res.ok) {
        setBuildStatus("failed");
        setFailureCode("unexpected");
      }
    } catch {
      setBuildStatus("failed");
      setFailureCode("unexpected");
    }
  }, [candidateId]);

  /** Follow a running build. Phases are read as keys so the rail can mark exactly what happened. */
  useEffect(() => {
    if (buildStatus !== "running") return;
    let cancelled = false;
    const id = setInterval(async () => {
      if (cancelled) return;
      const body = await syncBuild();
      if (!cancelled && body?.status === "done") await refresh();
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [buildStatus, syncBuild, refresh]);

  // The elapsed clock only ticks while something is actually running.
  useEffect(() => {
    if (buildStatus !== "running") return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [buildStatus]);

  /**
   * Walk the bounded rematch cursor to completion. The endpoint deliberately does one page per
   * request so a full pass cannot block the server for minutes; the client owns the loop.
   */
  const runEvaluation = useCallback(async () => {
    setEvaluating(true);
    setError(null);
    let afterJobId: number | undefined;
    let done = 0;
    try {
      for (let guard = 0; guard < 500; guard++) {
        const res = await fetch(`/api/candidates/${candidateId}/rematch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(afterJobId ? { afterJobId } : {}),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Evaluation failed.");
        const page = await res.json();
        // RematchCandidatePageResult's own field names — pairsAttempted is the count of
        // candidate/job pairs this page actually worked through.
        done += Number(page.pairsAttempted ?? 0);
        setEvaluatedCount(done);
        if (!page.hasMore || page.nextCursor == null) break;
        afterJobId = page.nextCursor;
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Evaluation failed.");
    } finally {
      setEvaluating(false);
    }
  }, [candidateId, refresh]);

  /* The moment the documents and target role are in place, build without being asked. Guarded on
   * failureCode so a failure shows guidance instead of retrying forever. */
  useEffect(() => {
    if (
      setup?.steps.resume &&
      setup.steps.skills &&
      setup.steps.preferences &&
      setup.profileStatus !== "ok" &&
      buildStatus === "idle" &&
      failureCode === null
    ) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      buildProfile();
    }
  }, [setup, buildStatus, failureCode, buildProfile]);

  // The moment everything it needs is in place, evaluate without being asked.
  useEffect(() => {
    if (setup?.canEvaluate && !setup.steps.evaluated && !evaluating) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      runEvaluation();
    }
  }, [setup, evaluating, runEvaluation]);

  /* ── phase ─────────────────────────────────────────────────────────────────────────────────── */

  const working = buildStatus === "running" || evaluating;
  const finished = Boolean(setup?.complete) && buildStatus !== "running";
  const showProtect = finished && hasPin === false && !pinDismissed;

  const phase: "setup" | "building" | "protect" | "done" = !loaded
    ? "setup"
    : showProtect
      ? "protect"
      : finished
        ? "done"
        : working || buildStatus === "failed"
          ? "building"
          : "setup";

  // Move focus to the rail when the build takes over, so keyboard and screen-reader users follow it.
  useEffect(() => {
    if (phase === "building") railRef.current?.focus();
  }, [phase]);

  const stages = useMemo(
    () =>
      buildStages({
        saved: savedOnce || Boolean(setup?.steps.resume && setup?.steps.skills),
        documentsPresent: Boolean(setup?.steps.resume && setup?.steps.skills),
        status: buildStatus,
        observed,
        failureCode,
        evaluating,
        evaluatedCount,
        hasEvaluated: Boolean(setup?.steps.evaluated),
      }),
    [savedOnce, setup, buildStatus, observed, failureCode, evaluating, evaluatedCount]
  );

  /* Named precisely rather than as a generic "form incomplete": not knowing what was missing or
   * where it lived is the whole reason this page was rebuilt. */
  const missing: string[] = [];
  if (!manifest.resume) missing.push("your Master Resume");
  if (!manifest.skills) missing.push("your Master Skills Inventory");
  if (!role.trim()) missing.push("a target role");
  const missingSentence = missing.join(", ").replace(/, ([^,]*)$/, " and $1");

  const elapsedSeconds = buildStartedAt ? Math.max(0, Math.floor((now - buildStartedAt) / 1000)) : 0;
  const clock = `${Math.floor(elapsedSeconds / 60)}:${String(elapsedSeconds % 60).padStart(2, "0")}`;

  const guidance = failureCode ? (FAILURE_GUIDANCE[failureCode] ?? FAILURE_GUIDANCE.unexpected) : null;

  /** The CLI's genuine current step, for the status panel. Null when nothing is running. */
  const cliActivity =
    buildStatus === "running" && observed.includes("reading_resume") && !observed.includes("writing")
      ? "Reading your documents."
      : buildStatus === "running" && observed.includes("writing")
        ? "Writing your profile."
        : buildStatus === "running"
          ? "Running."
          : buildStatus === "failed" && failureCode?.startsWith("cli_")
            ? "The last run did not finish."
            : null;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 py-6">
      <header>
        <h1 className="page-title">Set up this profile</h1>
        <p className="mt-1.5 max-w-[62ch] text-[12.5px] leading-relaxed text-tertiary">
          Everything needed before jobs can be matched is on this page. Fill it in and save — the
          profile builds in the background, and you can leave this page while it runs.
        </p>
      </header>

      {/* ── BUILDING / RESULT ─────────────────────────────────────────────────────────────────
          Placed above the form so the screen stays stable: the rail takes the primary position
          rather than the form collapsing out from under the user. */}
      {(phase === "building" || phase === "protect" || (phase === "done" && buildStatus === "done")) && (
        <Surface
          level="z3"
          className="rounded-[var(--radius-xl)] px-5 py-4 focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
        >
          <div ref={railRef} tabIndex={-1} className="outline-none">
            <BuildStageRail stages={stages} />
          </div>

          {buildStatus === "running" && (
            <p className="mt-3 text-[11.5px] tabular-nums text-tertiary">
              {clock} elapsed · usually about two minutes · safe to leave this page
            </p>
          )}

          <div className="mt-3">
            <ClaudeStatus state={cli.state} version={cli.version} activity={cliActivity} />
          </div>
        </Surface>
      )}

      {/* Failure: what broke, what is safe, what to do. Never a raw stack trace. */}
      {guidance && (
        <Surface level="z3" className="rounded-[var(--radius-xl)] border border-[var(--error)]/30 px-5 py-4">
          <h2 className="text-[13.5px] font-semibold text-[var(--error)]">{guidance.title}</h2>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-secondary">{guidance.what}</p>
          <p className="mt-2 text-[12px] leading-relaxed text-tertiary">
            <span className="font-medium text-secondary">Your data is safe. </span>
            {guidance.safe}
          </p>
          <p className="mt-2 text-[12.5px] leading-relaxed text-primary">{guidance.next}</p>

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={buildProfile}
              className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-[12.5px] font-semibold text-[var(--accent-fg)] transition-[background-color,transform] duration-150 ease-out hover:bg-[var(--accent-hover)] active:scale-[0.98]"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => {
                setFailureCode(null);
                setBuildStatus("idle");
                refresh();
              }}
              className="rounded-md border border-[var(--border)] px-3 py-1.5 text-[12.5px] font-medium text-secondary transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] hover:text-primary"
            >
              Back to setup
            </button>
          </div>

          {guidance.offerManual && setup && (
            <>
              <p className="mt-3 text-[11.5px] leading-relaxed text-tertiary">
                Or run this in Claude Code — it does exactly the same work:
              </p>
              <code className="mt-1.5 block select-all rounded-md bg-[var(--z0-bg)] px-3 py-2 text-[12.5px] text-primary">
                {setup.profileCommand}
              </code>
            </>
          )}
        </Surface>
      )}

      {/* Success: real counts from the validated profile. */}
      {buildStatus === "done" && summary && <ProfileReady summary={summary} />}

      {/* Optional PIN — offered once a profile exists and is worth protecting. */}
      {phase === "protect" && (
        <ProtectProfilePrompt
          candidateId={candidateId}
          onDone={() => {
            setPinDismissed(true);
            router.push("/jobs");
          }}
        />
      )}

      {phase === "done" && (
        <Surface level="z3" className="rounded-[var(--radius-xl)] px-5 py-4">
          <h2 className="text-[13.5px] font-semibold text-primary">Setup complete</h2>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-tertiary">
            {setup?.counts.evaluated.toLocaleString()} jobs evaluated ·{" "}
            {setup?.counts.readyForTailoring.toLocaleString()} ready for tailoring
          </p>
          <Link
            href="/jobs"
            className="mt-3 inline-block rounded-md bg-[var(--accent)] px-3.5 py-2 text-[13px] font-semibold text-[var(--accent-fg)] transition-[background-color,transform] duration-150 ease-out hover:bg-[var(--accent-hover)] active:scale-[0.98]"
          >
            Open Jobs →
          </Link>
        </Surface>
      )}

      {/* ── THE FORM ──────────────────────────────────────────────────────────────────────────
          Stays mounted and editable throughout. Hiding it during a build would lose whatever the
          user had typed and make a failure impossible to correct without starting again. */}
      <Surface level="z3" className="rounded-[var(--radius-xl)] px-5 py-4">
        <h2 className="text-[9.5px] font-semibold uppercase tracking-[0.11em] text-tertiary">About you</h2>
        <p className="mt-1.5 max-w-[58ch] text-[12px] leading-relaxed text-tertiary">
          Used verbatim in the header of every tailored resume and cover letter. Nothing here is
          guessed or filled in for you — a field left blank is simply left out.
        </p>

        <div className="mt-3.5 grid gap-3.5 sm:grid-cols-2">
          <Field
            label="First name"
            required
            autoComplete="given-name"
            value={identity.firstName}
            placeholder="Srikanth"
            onChange={(v) => setIdentity({ ...identity, firstName: v })}
          />
          <Field
            label="Last name"
            required
            autoComplete="family-name"
            value={identity.lastName}
            placeholder="Onteru"
            onChange={(v) => setIdentity({ ...identity, lastName: v })}
          />
          <Field
            label="Email"
            required
            type="email"
            inputMode="email"
            autoComplete="email"
            value={identity.email}
            placeholder="you@example.com"
            hint="The address a recruiter replies to."
            onChange={(v) => setIdentity({ ...identity, email: v })}
          />
          <Field
            label="Phone"
            required
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            value={identity.phone}
            placeholder="(214) 555-0123"
            onChange={(v) => setIdentity({ ...identity, phone: v })}
          />
          <Field
            label="Location"
            required
            autoComplete="address-level2"
            value={identity.location}
            placeholder="Dallas, TX"
            onChange={(v) => setIdentity({ ...identity, location: v })}
          />
          <Field
            label="LinkedIn"
            autoComplete="url"
            inputMode="url"
            value={identity.linkedin}
            placeholder="linkedin.com/in/your-profile"
            onChange={(v) => setIdentity({ ...identity, linkedin: v })}
          />
          <Field
            label="GitHub"
            autoComplete="url"
            inputMode="url"
            value={identity.github}
            placeholder="github.com/your-username"
            hint="Added to the resume header beside LinkedIn when supplied."
            onChange={(v) => setIdentity({ ...identity, github: v })}
          />
        </div>
      </Surface>

      <Surface level="z3" className="rounded-[var(--radius-xl)] px-5 py-4">
        <h2 className="text-[9.5px] font-semibold uppercase tracking-[0.11em] text-tertiary">Documents</h2>
        <p className="mt-1.5 max-w-[58ch] text-[12px] leading-relaxed text-tertiary">
          These two files are the source of truth. Every skill, employer and date the app claims
          comes from them — nothing is ever invented from outside them.
        </p>
        <div className="mt-3.5 grid gap-3 md:grid-cols-2">
          <UploadSlot
            slot="resume"
            label="Master Resume"
            description="Your full resume (.docx, .md, or .txt). Every tailored resume is derived from this."
            entry={manifest.resume}
            candidateId={candidateId}
            onUploaded={() => {
              loadManifest();
              refresh();
            }}
          />
          <UploadSlot
            slot="skills"
            label="Master Skills Inventory"
            description="Every technology you genuinely know, grouped by ecosystem. Decides what can be truthfully emphasized per job."
            entry={manifest.skills}
            candidateId={candidateId}
            onUploaded={() => {
              loadManifest();
              refresh();
            }}
          />
        </div>
      </Surface>

      <Surface level="z3" className="rounded-[var(--radius-xl)] px-5 py-4">
        <h2 className="text-[9.5px] font-semibold uppercase tracking-[0.11em] text-tertiary">Target role</h2>
        <p className="mt-1.5 max-w-[58ch] text-[12px] leading-relaxed text-tertiary">
          Used for ranking only — it never changes a match score or invents evidence.
        </p>
        <label className="mt-3.5 flex flex-col gap-1">
          <span className="flex items-baseline gap-1.5 text-[12px] font-medium text-secondary">
            Primary target role
            <span className="text-[10px] font-normal uppercase tracking-[0.07em] text-tertiary">required</span>
          </span>
          <input
            value={role}
            onChange={(e) => setRole(e.target.value)}
            placeholder="e.g. Data Engineer"
            className="w-full rounded-md border border-[var(--border)] bg-surface px-2.5 py-1.5 text-[16px] text-primary outline-none transition-colors duration-150 ease-out hover:border-[var(--accent)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] sm:text-[13px]"
          />
        </label>
      </Surface>

      <Surface level="z3" className="rounded-[var(--radius-xl)] px-5 py-4">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={saveAll}
            disabled={saving || buildStatus === "running"}
            className="rounded-md bg-[var(--accent)] px-3.5 py-2 text-[13px] font-semibold text-[var(--accent-fg)] transition-[background-color,transform] duration-150 ease-out hover:bg-[var(--accent-hover)] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? "Saving…" : buildStatus === "running" ? "Building…" : "Save and build my profile"}
          </button>
          {savedOnce && !saving && buildStatus === "idle" && (
            <span className="text-[12px] text-[var(--success)]">Saved.</span>
          )}
        </div>

        {/* When the action cannot do the whole job, say exactly what is missing. */}
        <p className="mt-2 text-[11.5px] leading-relaxed text-tertiary">
          {buildStatus === "running"
            ? "A build is already running. It continues even if you leave this page."
            : missing.length === 0
              ? "The profile build starts as soon as this is saved, and keeps running if you navigate away."
              : `Your details save now. Add ${missingSentence} to build your profile.`}
        </p>
      </Surface>

      {error && (
        <p role="alert" className="text-[12.5px] text-[var(--error)]">
          {error}
        </p>
      )}
    </div>
  );
}
