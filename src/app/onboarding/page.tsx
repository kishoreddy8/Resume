"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useActiveCandidateId } from "@/lib/useActiveCandidateId";
import { Surface, StatusDot, type StatusTone } from "@/components/ui";
import { BuildingProfile } from "@/components/BuildingProfile";
import { UploadSlot, type Manifest } from "@/components/MasterFileUpload";

/**
 * First-run setup, on ONE screen.
 *
 * WHY THIS PAGE EXISTS. A tester uploaded both documents, saw them listed as uploaded, and then got
 * zero matches forever with nothing explaining why. Uploading does not build the derived profile
 * the matching engine reads, and no screen said so. Every step is now stated here, in order.
 *
 * WHY IT IS ONE SCREEN. It used to be a checklist that sent people elsewhere for each item —
 * documents on /master-files, contact details buried in Settings — and coming back required
 * knowing to come back. The contact fields in particular were never found at all: they are
 * required before any resume can be rendered, but nothing in the first-run path mentioned them.
 * Everything needed to reach a first match is now collected in one place and saved in one action.
 *
 * WHAT SAVE ACTUALLY DOES. It writes the name, the contact details and the target role, then
 * starts the profile build on the server. The build is not awaited — it takes about two minutes,
 * and holding this page hostage for it is exactly what made people conclude the app had hung. It
 * continues if you navigate away, and the strip in the app chrome follows it.
 *
 * WHAT IS NEVER INVENTED. Contact details are used verbatim in resume and cover-letter headers, so
 * a blank field stays blank rather than being filled with something plausible. The profile build
 * reads only the two uploaded documents. A build whose result fails the matching engine's own
 * validation is discarded, leaving the previous profile untouched.
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

const STEP_LABEL: Record<string, string> = {
  resume: "Master Resume",
  skills: "Master Skills Inventory",
  preferences: "Target role",
  profile: "Candidate profile",
  evaluation: "Evaluation",
};

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
}: {
  label: string;
  hint?: string;
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[12px] font-medium text-secondary">{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-[var(--border)] bg-surface px-2.5 py-1.5 text-[13px] text-primary outline-none transition-colors duration-150 ease-out hover:border-[var(--accent)] focus:ring-2 focus:ring-[var(--focus-ring)]"
      />
      {hint && <span className="text-[11px] leading-relaxed text-tertiary">{hint}</span>}
    </label>
  );
}

export default function OnboardingPage() {
  const candidateId = useActiveCandidateId();
  const router = useRouter();
  const [setup, setSetup] = useState<Setup | null>(null);
  const [manifest, setManifest] = useState<Manifest>({});
  const [identity, setIdentity] = useState<Identity>(EMPTY_IDENTITY);
  const [role, setRole] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [evaluating, setEvaluating] = useState(false);
  const [building, setBuilding] = useState(false);
  const [buildFailed, setBuildFailed] = useState<string | null>(null);
  const [buildPhase, setBuildPhase] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
    loadManifest();
    loadIdentity();
  }, [refresh, loadManifest, loadIdentity]);

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

      setSavedAt(Date.now());
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }, [candidateId, identity, role, refresh]);

  /**
   * Start the profile build by running the user's own Claude Code CLI. Their subscription, no API key.
   *
   * POST only STARTS it — the response is 202 and the work continues server-side. If it fails for
   * any reason the manual command is shown instead; that fallback is never removed, because this
   * step is the one the whole match chain depends on and it must not become a dead end when the
   * CLI is unavailable, times out, or produces something that fails validation.
   */
  const buildProfile = useCallback(async () => {
    setBuilding(true);
    setBuildFailed(null);
    try {
      const res = await fetch(`/api/candidates/${candidateId}/build-profile`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setBuildFailed(body.error ?? "The profile build could not be started.");
        setBuilding(false);
      }
    } catch {
      setBuildFailed("Could not reach the server.");
      setBuilding(false);
    }
  }, [candidateId]);

  /**
   * Follow a running build to its end.
   *
   * The phase comes from the server as finished prose and is shown verbatim. There is no
   * percentage here on purpose — nothing knows what fraction of the work remains, so the honest
   * report is which step is happening now and how long it has been going.
   */
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
        if (body.status === "failed") setBuildFailed(body.error ?? "The profile build did not complete.");
        else await refresh();
      } catch {
        // A dropped poll is not a failed build; the next tick will find out either way.
      }
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [building, candidateId, refresh]);

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
        setProgress({ done });
        if (!page.hasMore || page.nextCursor == null) break;
        afterJobId = page.nextCursor;
      }
      const latest = await refresh();
      if (latest?.complete) router.push("/jobs");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Evaluation failed.");
    } finally {
      setEvaluating(false);
    }
  }, [candidateId, refresh, router]);

  /* The moment the documents and target role are in place, build the profile without being asked.
   * Guarded on buildFailed so a failure shows the manual command instead of retrying forever. */
  useEffect(() => {
    if (
      setup?.steps.resume &&
      setup.steps.skills &&
      setup.steps.preferences &&
      setup.profileStatus !== "ok" &&
      !building &&
      buildFailed === null
    ) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      buildProfile();
    }
  }, [setup, building, buildFailed, buildProfile]);

  // The moment everything it needs is in place, evaluate without being asked.
  useEffect(() => {
    if (setup?.canEvaluate && !setup.steps.evaluated && !evaluating) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      runEvaluation();
    }
  }, [setup, evaluating, runEvaluation]);

  const stepTone = (ok: boolean, isBlocker: boolean): StatusTone =>
    ok ? "ready" : isBlocker ? "active" : "neutral";

  /* Named precisely rather than as a generic "complete the form": the whole reason this page was
   * rebuilt is that people could not tell what was still missing or where it lived. */
  const missing: string[] = [];
  if (!setup?.steps.resume) missing.push("your Master Resume");
  if (!setup?.steps.skills) missing.push("your Master Skills Inventory");
  if (!role.trim()) missing.push("a target role");

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 py-6">
      <header>
        <h1 className="page-title">Set up this profile</h1>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-tertiary">
          Everything needed before jobs can be matched is on this page. Fill it in, save, and the
          profile builds in the background — you can leave this page while it runs.
        </p>
      </header>

      <Surface level="z3" className="rounded-[var(--radius-xl)] px-5 py-4">
        <ol className="space-y-2.5">
          {(["resume", "skills", "preferences", "profile", "evaluation"] as const).map((k) => {
            const ok =
              k === "evaluation" ? Boolean(setup?.steps.evaluated) : Boolean(setup?.steps[k as keyof Setup["steps"]]);
            const isBlocker = setup?.blockedOn === k;
            return (
              <li key={k} className="flex items-baseline gap-2.5">
                <StatusDot tone={stepTone(ok, isBlocker)} className="translate-y-[-1px]" />
                <span className={`text-[13px] ${ok ? "text-secondary" : isBlocker ? "font-semibold text-primary" : "text-tertiary"}`}>
                  {STEP_LABEL[k]}
                </span>
                {ok && <span className="text-[11px] text-[var(--success)]">done</span>}
                {isBlocker && <span className="text-[11px] text-[var(--accent)]">next</span>}
              </li>
            );
          })}
        </ol>
      </Surface>

      {/* 1 — who you are. These go into the header of every tailored resume, verbatim. */}
      <Surface level="z3" className="rounded-[var(--radius-xl)] px-5 py-4">
        <h2 className="text-[9.5px] font-semibold uppercase tracking-[0.11em] text-tertiary">About you</h2>
        <p className="mt-1.5 text-[12px] leading-relaxed text-tertiary">
          Used verbatim in the header of every tailored resume and cover letter. Nothing here is
          guessed or filled in for you — a field left blank is simply left out.
        </p>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field
            label="First name"
            value={identity.firstName}
            placeholder="Srikanth"
            onChange={(v) => setIdentity({ ...identity, firstName: v })}
          />
          <Field
            label="Last name"
            value={identity.lastName}
            placeholder="Onteru"
            onChange={(v) => setIdentity({ ...identity, lastName: v })}
          />
          <Field
            label="Email"
            type="email"
            value={identity.email}
            placeholder="you@example.com"
            hint="The address a recruiter replies to."
            onChange={(v) => setIdentity({ ...identity, email: v })}
          />
          <Field
            label="Phone"
            type="tel"
            value={identity.phone}
            placeholder="(214) 555-0123"
            onChange={(v) => setIdentity({ ...identity, phone: v })}
          />
          <Field
            label="Location"
            value={identity.location}
            placeholder="Dallas, TX"
            onChange={(v) => setIdentity({ ...identity, location: v })}
          />
          <Field
            label="LinkedIn (optional)"
            value={identity.linkedin}
            placeholder="linkedin.com/in/your-profile"
            onChange={(v) => setIdentity({ ...identity, linkedin: v })}
          />
          <Field
            label="GitHub (optional)"
            value={identity.github}
            placeholder="github.com/your-username"
            hint="Added to the resume header beside LinkedIn when supplied."
            onChange={(v) => setIdentity({ ...identity, github: v })}
          />
        </div>
      </Surface>

      {/* 2 & 3 — the documents, uploaded here rather than on another page */}
      <Surface level="z3" className="rounded-[var(--radius-xl)] px-5 py-4">
        <h2 className="text-[9.5px] font-semibold uppercase tracking-[0.11em] text-tertiary">Documents</h2>
        <p className="mt-1.5 text-[12px] leading-relaxed text-tertiary">
          These two files are the source of truth. Every skill, employer and date the app claims
          comes from them — nothing is ever invented from outside them.
        </p>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
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

      {/* 4 — target role */}
      <Surface level="z3" className="rounded-[var(--radius-xl)] px-5 py-4">
        <h2 className="text-[9.5px] font-semibold uppercase tracking-[0.11em] text-tertiary">Target role</h2>
        <p className="mt-1.5 text-[12px] leading-relaxed text-tertiary">
          Used for ranking only — it never changes a match score or invents evidence.
        </p>
        <input
          value={role}
          onChange={(e) => setRole(e.target.value)}
          placeholder="e.g. Data Engineer"
          aria-label="Primary target role"
          className="mt-3 w-full rounded-md border border-[var(--border)] bg-surface px-2.5 py-1.5 text-[13px] text-primary outline-none transition-colors duration-150 ease-out hover:border-[var(--accent)] focus:ring-2 focus:ring-[var(--focus-ring)]"
        />
      </Surface>

      {/* One action for the whole page. Saving is what sets the build in motion. */}
      <Surface level="z3" className="rounded-[var(--radius-xl)] px-5 py-4">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={saveAll}
            disabled={saving}
            className="rounded-md bg-[var(--accent)] px-3.5 py-2 text-[13px] font-semibold text-[var(--accent-fg)] transition-[background-color,transform] duration-150 ease-out hover:bg-[var(--accent-hover)] active:scale-[0.98] disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save and build my profile"}
          </button>
          {savedAt !== null && !saving && (
            <span className="text-[12px] text-[var(--success)]">Saved.</span>
          )}
        </div>
        <p className="mt-2 text-[11.5px] leading-relaxed text-tertiary">
          {missing.length === 0
            ? "The profile build starts as soon as this is saved, and keeps running if you navigate away."
            : `Your details save now. The profile build needs ${missing.join(", ").replace(/, ([^,]*)$/, " and $1")} before it can start.`}
        </p>
      </Surface>

      {/* 5 — automatic, with the manual command as a fallback that never disappears */}
      {setup && setup.steps.resume && setup.steps.skills && setup.profileStatus !== "ok" && (
        <Surface level="z3" className="tint-craft rounded-[var(--radius-xl)] px-5 py-4">
          <h2 className="text-[9.5px] font-semibold uppercase tracking-[0.11em] text-tertiary">
            Candidate profile
          </h2>

          {building ? (
            <div className="mt-2">
              <BuildingProfile candidateId={candidateId} phase={buildPhase} />
            </div>
          ) : buildFailed ? (
            <>
              <p className="mt-1.5 text-[12.5px] text-[var(--error)]">{buildFailed}</p>
              <p className="mt-1.5 text-[11.5px] leading-relaxed text-tertiary">
                Run this in Claude Code instead — it does exactly the same work:
              </p>
              <code className="mt-2 block select-all rounded-md bg-[var(--z0-bg)] px-3 py-2 text-[12.5px] text-primary">
                {setup.profileCommand}
              </code>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={buildProfile}
                  className="rounded-md border border-[var(--border)] px-3 py-1.5 text-[12.5px] font-medium text-secondary transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] hover:text-primary"
                >
                  Try again
                </button>
                <button
                  type="button"
                  onClick={() => refresh()}
                  className="rounded-md border border-[var(--border)] px-3 py-1.5 text-[12.5px] font-medium text-secondary transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] hover:text-primary"
                >
                  I ran it — check again
                </button>
              </div>
            </>
          ) : (
            <p className="mt-1.5 text-[12.5px] text-secondary">
              {setup.profileStatus === "stale"
                ? "The documents changed, so the profile is being rebuilt."
                : "Starting automatically…"}
            </p>
          )}

          <p className="mt-2.5 text-[11px] leading-relaxed text-tertiary">
            Nothing is accepted on trust: the result must pass the same validation the matching
            engine uses, and a build that fails leaves the previous profile untouched.
          </p>
        </Surface>
      )}

      {/* 6 — automatic */}
      {setup?.canEvaluate && (
        <Surface level="z3" className="rounded-[var(--radius-xl)] px-5 py-4">
          <h2 className="text-[9.5px] font-semibold uppercase tracking-[0.11em] text-tertiary">Evaluation</h2>
          {evaluating ? (
            <p className="mt-1.5 text-[12.5px] text-secondary">
              Evaluating jobs against this profile… {progress ? `${progress.done.toLocaleString()} so far` : ""}
            </p>
          ) : setup.steps.evaluated ? (
            <p className="mt-1.5 text-[12.5px] text-[var(--success)]">
              {setup.counts.evaluated.toLocaleString()} jobs evaluated · {setup.counts.readyForTailoring} ready for
              tailoring
            </p>
          ) : (
            <p className="mt-1.5 text-[12.5px] text-secondary">Starting automatically…</p>
          )}
        </Surface>
      )}

      {error && <p className="text-[12.5px] text-[var(--error)]">{error}</p>}

      {setup?.complete && (
        <Link
          href="/jobs"
          className="self-start rounded-md bg-[var(--accent)] px-3.5 py-2 text-[13px] font-semibold text-[var(--accent-fg)] transition-[background-color,transform] duration-150 ease-out hover:bg-[var(--accent-hover)] active:scale-[0.98]"
        >
          Open Jobs →
        </Link>
      )}
    </div>
  );
}
