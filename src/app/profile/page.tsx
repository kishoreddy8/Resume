"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useResolvedCandidateId } from "@/lib/useActiveCandidateId";
import {
  BTN_SECONDARY,
  Disclosure,
  INPUT,
  LoadingRegion,
  PageHeader,
  Panel,
  PanelEmpty,
  SkeletonRows,
  Tag,
} from "@/components/ui";
import {
  IconBriefcase,
  IconCheckCircle,
  IconDocument,
  IconInbox,
  IconPin,
  IconShield,
  IconStar,
  IconUser,
} from "@/components/icons";
import type { Manifest } from "@/components/MasterFileUpload";
import { EditableSection } from "./EditableSection";
import {
  CLEARANCE_OPTIONS,
  EMPLOYMENT_OPTIONS,
  WORKPLACE_OPTIONS,
  formatSpan,
  type CandidateRecord,
  type CandidateSettingsPayload,
  type ContactValues,
  type EvidenceProfile,
  type PreferenceValues,
  type WorkAuthValues,
} from "./types";

/**
 * Profile — the professional information Career-Ops uses.
 *
 * WHAT THIS ROUTE USED TO BE. A `useEffect` that redirected to /candidates/<id>/settings, which is
 * a form. So "Profile" was a place you passed through on the way to editing four fields, and the
 * evidence Career-Ops actually reasons over lived on a different route called Candidate Intelligence.
 *
 * TWO KINDS OF INFORMATION, AND THE DIFFERENCE IS LOAD-BEARING. Contact, target roles, preferences
 * and work authorization are things you STATE: editable here, section by section, and the only
 * things this page can write. Experience, education, certifications and skills are DERIVED from
 * your master resume and skills inventory by the profile builder — read-only on purpose, because
 * the way to correct them is to replace the document, and a text field over derived evidence would
 * produce a profile that disagrees with the documents every tailored resume is validated against.
 *
 * WHERE THE REFERENCE AND THE DATA DISAGREE, THE DATA WINS. The reference's Skills panel shows one
 * round "42 verified skills" over five category chips. Neither exists here: the wire carries 38
 * employer-attributed skills and 497 that appear only in the Master Skills Inventory, and there is
 * no category field at all. Collapsing those into a single figure would overstate what can actually
 * be evidenced, and Data / Cloud / Programming chips would be a taxonomy this file invented and
 * presented as yours. The panel keeps its position and geometry and states both real numbers.
 * Application information likewise keeps its slot, with the truth that no reusable answers exist.
 *
 * NO COMPLETENESS SCORE. There is no deterministic completeness contract in the product, so a
 * "profile 92% complete" ring would be a number invented by this file.
 *
 * UI-P — PROFILE STATUS WAS BEING DISCARDED. `/api/candidates/:id/profile` has always returned
 * `status: "ok" | "missing" | "stale" | "invalid"` (the same contract `loadCandidateProfile` gives
 * Candidate Intelligence and Home), but this page previously collapsed every non-"ok" status into
 * the same `evidence: null` and let each empty panel say "not on file yet" — true for `missing`,
 * misleading for `stale` (experience/skills DO exist, they're just not trusted right now) and for
 * `invalid` (a real error, not an empty state). The status is now kept and surfaced once, honestly,
 * in its own section — see the "Needs your review" panel below. The real fix action lives on
 * Candidate Intelligence (the page with the actual "Build profile now" control and progress
 * polling) — this page links there rather than re-implementing a second build UI.
 *
 * UI-P — CAREER FILES. Master Resume / Master Skills Inventory presence (from the same manifest
 * /master-files already reads) is now summarized here too, so "what evidence is this profile built
 * from" is answered in one place instead of requiring a detour to Master Files to find out.
 *
 * FOUR PAYLOADS, IN PARALLEL, ONCE. No per-section request, no AI call, no polling.
 */

type ProfileStatus = "ok" | "missing" | "stale" | "invalid";

type Loaded = {
  candidate: CandidateRecord;
  evidence: EvidenceProfile | null;
  profileStatus: ProfileStatus;
  profileError: string | null;
  settings: CandidateSettingsPayload;
  masterFiles: Manifest;
};

function fullName(c: CandidateRecord): string {
  return c.display_name?.trim() || [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || "Your profile";
}

/**
 * Honest, per-reason copy for a profile that is not "ok" — the same three real conditions
 * loadCandidateProfile reports everywhere else (Home, Candidate Intelligence). The fix action is
 * always Candidate Intelligence: that is the page with the real "Build profile now" control and
 * progress polling, not a second build UI invented for this page.
 *
 * UI-P.1 — "stale" softened from "changed" to "may have changed": loadCandidateProfile's own source
 * reports stale identically whether the source files provably changed OR their freshness simply
 * can't be verified (pre-sha256 uploads have no hash to compare at all) — asserting a definite
 * change would overclaim in that second, real case.
 *
 * UI-P.1 — "invalid" no longer states a specific cause in its primary sentence. The real
 * loadCandidateProfile error can be a raw JSON-parse message, a Zod validation error naming internal
 * schema paths, or a schemaVersion mismatch — none of that is candidate-friendly, and Candidate
 * Intelligence exposing the same raw string elsewhere is not a reason to do it here too. The exact
 * message is now behind an explicit "Technical details" disclosure (the same pattern ErrorState
 * already uses), not the primary sentence a candidate reads first.
 */
const PROFILE_REVIEW_COPY: Record<Exclude<ProfileStatus, "ok">, { title: string; detail: string }> = {
  missing: {
    title: "Your professional profile hasn't been built yet.",
    detail: "Career-Ops builds this from your Master Resume and Skills Inventory — the sections below stay empty until it runs once.",
  },
  stale: {
    title: "Your professional profile needs a refresh.",
    detail: "Your master resume or skills inventory may have changed since this was built, so the experience and skills below are hidden until it's rebuilt.",
  },
  invalid: {
    title: "Your professional profile needs review.",
    detail: "Some information in your saved profile could not be read.",
  },
};

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[words.length - 1]![0]!).toUpperCase();
}

/** PATCH one bucket of candidate settings. The route enforces three separate optional partials
 *  rather than one flat object, and this respects that boundary — a contact edit can never reach
 *  the match-affecting bucket, so it can never invalidate a match cache. */
async function patchSettings(
  candidateId: number,
  body: Partial<Pick<CandidateSettingsPayload, "contact" | "preferences" | "matchAffecting">>
): Promise<void> {
  const res = await fetch(`/api/candidates/${candidateId}/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    const first = Array.isArray(detail?.errors) ? detail.errors[0]?.message : null;
    throw new Error(first ?? "We couldn't save this. Nothing was changed.");
  }
}

/** One line in a quick-section card — the reference's compact diamond list. */
function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5 text-[14px] leading-6 text-primary">
      <span aria-hidden="true" className="mt-[7px] h-1.5 w-1.5 shrink-0 rotate-45 bg-[var(--accent)]" />
      <span className="min-w-0">{children}</span>
    </li>
  );
}

function EmptyLine({ children }: { children: React.ReactNode }) {
  return <p className="text-[14px] leading-6 text-tertiary">{children}</p>;
}

/** A figure in the identity strip. Renders zero rather than hiding, so the strip's shape never
 *  depends on the data. `sub` is omitted entirely when there is nothing true to say. */
function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string | null }) {
  return (
    <div className="min-w-0">
      <div className="text-[13px] font-semibold uppercase tracking-[0.065em] text-tertiary">{label}</div>
      <div className="mt-1.5 text-[25px] font-bold leading-none tracking-[-0.02em] tabular-nums text-primary">
        {value}
      </div>
      {sub && <div className="mt-1.5 truncate text-[14px] text-tertiary">{sub}</div>}
    </div>
  );
}

export default function ProfilePage() {
  const candidateId = useResolvedCandidateId();
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState(false);
  const [identitySignal, setIdentitySignal] = useState(0);

  const load = useCallback(async () => {
    if (candidateId === null) return;
    setError(false);
    try {
      const [cRes, pRes, sRes, mRes] = await Promise.all([
        fetch(`/api/candidates/${candidateId}`),
        fetch(`/api/candidates/${candidateId}/profile`),
        fetch(`/api/candidates/${candidateId}/settings`),
        fetch(`/api/master-files?candidateId=${candidateId}`),
      ]);
      if (!cRes.ok || !sRes.ok) return setError(true);
      const [cBody, pBody, sBody, mBody] = await Promise.all([
        cRes.json(),
        pRes.ok ? pRes.json() : null,
        sRes.json(),
        mRes.ok ? mRes.json() : null,
      ]);
      setData({
        candidate: cBody.candidate,
        /* A profile that has not been built yet is a real state, not a failure: each panel says so
         * in its own words rather than the page refusing to render. */
        evidence: pBody?.status === "ok" ? (pBody.profile as EvidenceProfile) : null,
        profileStatus: (pBody?.status as ProfileStatus | undefined) ?? "missing",
        profileError: pBody?.status === "invalid" ? (pBody.error as string | null) : null,
        settings: sBody as CandidateSettingsPayload,
        masterFiles: (mBody?.manifest as Manifest | undefined) ?? {},
      });
    } catch {
      setError(true);
    }
  }, [candidateId]);

  useEffect(() => {
    // Intentional: fetch-on-mount with an explicit error flag, not a render loop.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const skills = useMemo(() => {
    const all = data?.evidence?.skills ?? [];
    return {
      all,
      employer: all.filter((s) => s.source === "employer"),
      inventory: all.filter((s) => s.source !== "employer"),
    };
  }, [data]);

  if (error) {
    return (
      <div className="mx-auto flex w-full max-w-[var(--candidate-page-max)] flex-col gap-6">
        <PageHeader size="lg" title="Profile" />
        <Panel>
          <PanelEmpty
            action={
              <button type="button" onClick={load} className={BTN_SECONDARY}>
                Retry
              </button>
            }
          >
            We couldn&apos;t load your profile.
          </PanelEmpty>
        </Panel>
      </div>
    );
  }

  if (candidateId === null || data === null) {
    return (
      <div className="mx-auto flex w-full max-w-[var(--candidate-page-max)] flex-col gap-5">
        <PageHeader
          size="lg"
          title="Profile"
          description="Your professional information and evidence used across Career-Ops."
        />
        <LoadingRegion label="Loading your profile" />
        <Panel>
          <SkeletonRows rows={3} />
        </Panel>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Panel key={i} compact>
              <SkeletonRows rows={2} />
            </Panel>
          ))}
        </div>
      </div>
    );
  }

  const { candidate, evidence, profileStatus, profileError, settings, masterFiles } = data;
  const name = fullName(candidate);
  const prefs = settings.preferences;
  const contact = settings.contact;
  const auth = settings.matchAffecting;

  const roleCount = (prefs.primaryTargetRole ? 1 : 0) + prefs.secondaryTargetRoles.length;
  const experience = evidence?.experience ?? [];
  const education = evidence?.education ?? [];
  const certifications = evidence?.certifications ?? [];
  const review = profileStatus === "ok" ? null : PROFILE_REVIEW_COPY[profileStatus];

  return (
    <div className="mx-auto flex w-full max-w-[var(--candidate-page-max)] flex-col gap-6 pb-12">
      <PageHeader
        size="lg"
        title="Profile"
        description="Your professional information and evidence used across Career-Ops."
      />

      {/* ── identity ─────────────────────────────────────────────────────────────────────────── */}
      {/* Deterministic initials, never a stock photo: the product stores no avatar, and a generated
       *  face would be the one invented thing on a page about being accurate. */}
      <section aria-labelledby="profile-identity-title" className="premium-gradient-surface rounded-[18px] border border-[var(--border)] p-5 shadow-[var(--lift-1)] sm:p-7">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
          <span
            aria-hidden="true"
            className="grid h-16 w-16 shrink-0 place-items-center rounded-[18px] bg-[var(--tile-lav-bg)] text-[22px] font-bold text-[var(--tile-lav-fg)]"
          >
            {initials(name)}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold uppercase tracking-[0.075em] text-[var(--accent)]">Professional profile</p>
            <h2 id="profile-identity-title" className="mt-1 text-[26px] font-bold leading-tight tracking-[-0.025em] text-primary sm:text-[30px]">{name}</h2>
            <p className="mt-1 text-[15px] font-medium text-secondary">
              {prefs.primaryTargetRole ?? <span className="text-tertiary">No target role selected</span>}
            </p>
            <p className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-[14px] text-tertiary">
              <span className="flex items-center gap-1.5">
                <IconPin size={14} aria-hidden="true" />
                {contact.location ?? "Location not set"}
              </span>
              <span className="flex items-center gap-1.5">
                <IconDocument size={14} aria-hidden="true" />
                {contact.email ?? "Email not set"}
              </span>
              <span className="flex items-center gap-1.5">
                <IconUser size={14} aria-hidden="true" />
                {contact.phone ?? "Phone not set"}
              </span>
            </p>
          </div>
          <button type="button" onClick={() => setIdentitySignal((n) => n + 1)} className={`${BTN_SECONDARY} min-h-11 text-[14px]`}>
            Edit identity
          </button>
        </div>

        {/* Four real counts. Experience is the builder's own totalYearsExperience — this page never
         *  derives years from date arithmetic the product does not itself do. */}
        <div className="mt-6 grid grid-cols-2 gap-5 border-t border-[var(--separator)] pt-5 sm:grid-cols-4">
          <Stat
            label="Target roles"
            value={roleCount}
            sub={prefs.primaryTargetRole ? `Primary: ${prefs.primaryTargetRole}` : null}
          />
          <Stat
            label="Experience"
            value={evidence?.totalYearsExperience != null ? `${evidence.totalYearsExperience} yrs` : "—"}
            sub={experience.length > 0 ? `${experience.length} ${experience.length === 1 ? "role" : "roles"}` : null}
          />
          <Stat
            label="Education"
            value={education.length}
            sub={education.length > 0 ? (education.length === 1 ? "qualification" : "qualifications") : null}
          />
          <Stat
            label="Skills"
            value={skills.all.length}
            sub={skills.all.length > 0 ? `${skills.employer.length} employer-backed` : null}
          />
        </div>
      </section>

      {/* ── needs your review ────────────────────────────────────────────────────────────────── */}
      {/* Only rendered when loadCandidateProfile actually reports a non-"ok" status — never a
       *  fabricated warning, and never a second priority engine competing with Home's next-action
       *  card. This is profile-specific review, not global "what needs me". */}
      {review && (
        <section aria-labelledby="profile-review-title" className="rounded-[18px] border border-[var(--border)] bg-[var(--z3-bg)] p-5 shadow-[var(--shadow-card)] sm:p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex items-start gap-3">
              <span aria-hidden="true" className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-[var(--tile-amber-bg)] text-[var(--tile-amber-fg)]">
                <IconInbox size={17} />
              </span>
              <div className="min-w-0">
                <p className="text-[13px] font-semibold uppercase tracking-[0.075em] text-[var(--pill-amber-fg)]">Needs your review</p>
                <h2 id="profile-review-title" className="mt-1 text-[18px] font-bold leading-snug text-primary">{review.title}</h2>
                <p className="mt-1.5 max-w-[62ch] text-[14px] leading-6 text-secondary">{review.detail}</p>
                {profileStatus === "invalid" && profileError && (
                  <div className="mt-2 max-w-[62ch]">
                    <Disclosure title="Technical details">
                      <p className="text-[13px] leading-6 text-tertiary">{profileError}</p>
                    </Disclosure>
                  </div>
                )}
              </div>
            </div>
            <Link href="/candidate-intelligence" className={`${BTN_SECONDARY} min-h-11 shrink-0 text-[14px]`}>
              {profileStatus === "missing" ? "Build profile" : "Review profile"}
            </Link>
          </div>
        </section>
      )}

      {/* ── quick sections ───────────────────────────────────────────────────────────────────── */}
      <div>
        <p className="text-[13px] font-semibold uppercase tracking-[0.075em] text-[var(--accent)]">Candidate facts</p>
        <h2 className="mt-1 text-[22px] font-bold tracking-[-0.02em] text-primary">Professional information</h2>
        <p className="mt-1 text-[14px] leading-6 text-secondary">Edit only information you provide directly. Resume evidence remains read-only.</p>
      </div>
      {/* The compact gap keeps the two factual columns reading as one workspace rather than two
       * separate islands. Cards still stretch within each row, so editing one never creates a
       * ragged alignment beside it. */}
      <div className="grid grid-cols-1 items-stretch gap-3 md:grid-cols-2 [&>*]:h-full">
        {/* Remounted by the header's "Edit profile", which is what opens it — a new key rebuilds
         *  the draft from the persisted value, so no effect is needed to force the state. */}
        <EditableSection<ContactValues>
          key={`identity-${identitySignal}`}
          title="Professional identity"
          compact
          icon={<IconUser size={16} />}
          defaultOpen={identitySignal > 0}
          value={contact}
          onSave={async (draft) => {
            await patchSettings(candidateId, { contact: draft });
            await load();
          }}
          view={(v) => (
            <ul className="flex flex-col gap-1.5">
              <Bullet>{name}</Bullet>
              {v.email ? <Bullet>{v.email}</Bullet> : null}
              {v.phone ? <Bullet>{v.phone}</Bullet> : null}
              {v.location ? <Bullet>{v.location}</Bullet> : null}
              {v.linkedin ? <Bullet>{v.linkedin}</Bullet> : null}
              {!v.email && !v.phone && !v.location && <EmptyLine>No contact details set.</EmptyLine>}
            </ul>
          )}
          form={(draft, set) => (
            <div className="flex flex-col gap-3">
              {(
                [
                  ["email", "Email", "email"],
                  ["phone", "Phone", "tel"],
                  ["location", "Location", "text"],
                  ["linkedin", "LinkedIn", "text"],
                  ["github", "GitHub", "text"],
                ] as const
              ).map(([key, label, type]) => (
                <label key={key} className="flex flex-col gap-1.5">
                  <span className="text-[14px] font-semibold text-secondary">{label}</span>
                  <input
                    type={type}
                    className={INPUT}
                    value={draft[key] ?? ""}
                    onChange={(e) => set({ ...draft, [key]: e.target.value.trim() === "" ? null : e.target.value })}
                  />
                </label>
              ))}
            </div>
          )}
        />

        <EditableSection<PreferenceValues>
          title="Target roles"
          compact
          icon={<IconBriefcase size={16} />}
          value={prefs}
          editLabel={roleCount === 0 ? "Add role" : "Edit"}
          onSave={async (draft) => {
            await patchSettings(candidateId, {
              preferences: {
                ...draft,
                secondaryTargetRoles: draft.secondaryTargetRoles.filter((r) => r.trim() !== ""),
              },
            });
            await load();
          }}
          view={(v) =>
            roleCount === 0 ? (
              <EmptyLine>No target roles set.</EmptyLine>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {v.primaryTargetRole && <Bullet>{v.primaryTargetRole}</Bullet>}
                {v.secondaryTargetRoles.map((r) => (
                  <Bullet key={r}>{r}</Bullet>
                ))}
              </ul>
            )
          }
          form={(draft, set) => (
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1.5">
                <span className="text-[14px] font-semibold text-secondary">Primary target role</span>
                <input
                  className={INPUT}
                  value={draft.primaryTargetRole ?? ""}
                  placeholder="Data Engineer"
                  onChange={(e) =>
                    set({ ...draft, primaryTargetRole: e.target.value.trim() === "" ? null : e.target.value })
                  }
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-[14px] font-semibold text-secondary">Also considering</span>
                <input
                  className={INPUT}
                  value={draft.secondaryTargetRoles.join(", ")}
                  placeholder="Azure Data Engineer, AI Engineer"
                  onChange={(e) =>
                    set({ ...draft, secondaryTargetRoles: e.target.value.split(",").map((r) => r.trim()) })
                  }
                />
                <span className="text-[13px] text-tertiary">Comma separated. Up to ten.</span>
              </label>
            </div>
          )}
        />

        <EditableSection<PreferenceValues>
          title="Work preferences"
          compact
          icon={<IconPin size={16} />}
          value={prefs}
          onSave={async (draft) => {
            await patchSettings(candidateId, { preferences: draft });
            await load();
          }}
          view={(v) =>
            v.workplacePreference.length === 0 && !v.employmentTypePreference && !v.locationPreference ? (
              <EmptyLine>No work preferences set.</EmptyLine>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {v.workplacePreference.length > 0 && <Bullet>{v.workplacePreference.join(" · ")}</Bullet>}
                {v.employmentTypePreference && <Bullet>{v.employmentTypePreference}</Bullet>}
                {v.locationPreference ? (
                  <Bullet>{v.locationPreference}</Bullet>
                ) : (
                  <li className="text-[12.5px] text-tertiary">Preferred location not set</li>
                )}
              </ul>
            )
          }
          form={(draft, set) => (
            <div className="flex flex-col gap-3.5">
              <label className="flex flex-col gap-1.5">
                <span className="text-[14px] font-semibold text-secondary">Preferred location</span>
                <input
                  className={INPUT}
                  value={draft.locationPreference ?? ""}
                  placeholder="Dallas, TX"
                  onChange={(e) =>
                    set({ ...draft, locationPreference: e.target.value.trim() === "" ? null : e.target.value })
                  }
                />
              </label>
              <fieldset>
                <legend className="mb-2 text-[14px] font-semibold text-secondary">Workplace</legend>
                <div className="flex flex-col gap-1.5">
                  {WORKPLACE_OPTIONS.map((opt) => (
                    <label key={opt} className="flex min-h-11 items-center gap-3 text-[14px] text-primary">
                      <input
                        type="checkbox"
                        className="h-5 w-5 accent-[var(--accent)]"
                        checked={draft.workplacePreference.includes(opt)}
                        onChange={(e) =>
                          set({
                            ...draft,
                            workplacePreference: e.target.checked
                              ? [...draft.workplacePreference, opt]
                              : draft.workplacePreference.filter((w) => w !== opt),
                          })
                        }
                      />
                      {opt}
                    </label>
                  ))}
                </div>
              </fieldset>
              <label className="flex flex-col gap-1.5">
                <span className="text-[14px] font-semibold text-secondary">Employment type</span>
                <select
                  className={INPUT}
                  value={draft.employmentTypePreference ?? ""}
                  onChange={(e) =>
                    set({ ...draft, employmentTypePreference: e.target.value === "" ? null : e.target.value })
                  }
                >
                  <option value="">Not set</option>
                  {EMPLOYMENT_OPTIONS.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
        />

        {/* Every value here is one you stated. JobHunt never infers authorization from your history,
         *  from the jobs you open, or from anything in your resume — and these are the only facts
         *  the eligibility engine reads, so what is shown is exactly what filters your jobs. */}
        <EditableSection<WorkAuthValues>
          title="Work authorization"
          compact
          icon={<IconShield size={16} />}
          value={auth}
          onSave={async (draft) => {
            await patchSettings(candidateId, { matchAffecting: draft });
            await load();
          }}
          view={(v) => (
            <ul className="flex flex-col gap-1.5">
              <Bullet>
                {v.workAuthorizedUS ? "Authorized to work in the U.S." : "Not authorized to work in the U.S."}
              </Bullet>
              <Bullet>{v.requiresSponsorship ? "Requires sponsorship" : "Does not require sponsorship"}</Bullet>
              {v.usCitizen && <Bullet>U.S. citizen</Bullet>}
              <Bullet>Clearance: {v.clearanceLevel}</Bullet>
            </ul>
          )}
          form={(draft, set) => (
            <div className="flex flex-col gap-2.5">
              <p className="rounded-[10px] bg-[var(--tile-blue-bg)] px-4 py-3 text-[13px] leading-5 text-[var(--pill-blue-fg)]">
                Changing these re-evaluates which jobs you&apos;re eligible for.
              </p>
              {(
                [
                  ["workAuthorizedUS", "Authorized to work in the U.S."],
                  ["requiresSponsorship", "I require visa sponsorship"],
                  ["usCitizen", "I am a U.S. citizen"],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="flex min-h-11 items-center gap-3 text-[14px] text-primary">
                  <input
                    type="checkbox"
                    className="h-5 w-5 accent-[var(--accent)]"
                    checked={draft[key]}
                    onChange={(e) => set({ ...draft, [key]: e.target.checked })}
                  />
                  {label}
                </label>
              ))}
              <label className="mt-1 flex flex-col gap-1.5">
                <span className="text-[14px] font-semibold text-secondary">Security clearance</span>
                <select
                  className={INPUT}
                  value={draft.clearanceLevel}
                  onChange={(e) => set({ ...draft, clearanceLevel: e.target.value })}
                >
                  {CLEARANCE_OPTIONS.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
        />
      </div>

      {/* ── lower grid ───────────────────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 items-start gap-3 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,.95fr)]">
        {/* left: what you have done */}
        <div className="flex flex-col gap-5">
          <Panel
            title="Experience"
            description={
              experience.length > 0
                ? `${evidence?.totalYearsExperience ?? "—"} years · ${experience.length} ${
                    experience.length === 1 ? "role" : "roles"
                  } · read from your master resume`
                : undefined
            }
          >
            {experience.length === 0 ? (
              <PanelEmpty
                action={
                  <Link href="/master-files" className={BTN_SECONDARY}>
                    Add your master resume
                  </Link>
                }
              >
                No experience on file yet. Career-Ops reads this from your master resume.
              </PanelEmpty>
            ) : (
              <ul className="flex flex-col divide-y divide-[var(--separator)]">
                {experience.map((e, i) => (
                  <li key={`${e.employer}-${i}`} className="flex gap-3 py-3.5 first:pt-0 last:pb-0">
                    <span
                      aria-hidden="true"
                      className="mt-0.5 grid h-[34px] w-[34px] shrink-0 place-items-center rounded-[10px] bg-[var(--tile-lav-bg)] text-[var(--tile-lav-fg)]"
                    >
                      <IconBriefcase size={16} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[17px] font-bold leading-snug text-primary">{e.title}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[14px] text-secondary">
                        <span>{e.employer}</span>
                        {formatSpan(e.startDate, e.endDate) && (
                          <span className="text-tertiary">· {formatSpan(e.startDate, e.endDate)}</span>
                        )}
                      </div>
                      {/* Technologies, not resume bullets — the bullets are the document's job, and
                       *  what is useful here is what this role can be used as evidence FOR. */}
                      {e.technologies && e.technologies.length > 0 && (
                        <details className="group mt-2">
                          <summary className="inline-flex min-h-11 cursor-pointer list-none items-center text-[14px] font-semibold text-[var(--accent)] transition-colors duration-150 ease-out hover:text-[var(--accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]">
                            View details · {e.technologies.length} technologies
                            <span className="ml-1 inline-block transition-transform duration-150 group-open:rotate-90">
                              ›
                            </span>
                          </summary>
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {e.technologies.map((t) => (
                              <Tag key={t}>{t}</Tag>
                            ))}
                          </div>
                        </details>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Education">
            {education.length === 0 ? (
              <PanelEmpty>Education not added.</PanelEmpty>
            ) : (
              <ul className="flex flex-col divide-y divide-[var(--separator)]">
                {education.map((e, i) => (
                  <li key={`${e.institution}-${i}`} className="py-3 first:pt-0 last:pb-0">
                    <div className="text-[16px] font-bold leading-snug text-primary">
                      {[e.level, e.field].filter(Boolean).join(", ") || e.institution || "Qualification"}
                    </div>
                    {e.institution && <div className="mt-1 text-[14px] text-tertiary">{e.institution}</div>}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        {/* right: what can be evidenced */}
        <div className="flex flex-col gap-5">
          <SkillsPanel employer={skills.employer} inventory={skills.inventory} />

          <CareerFilesPanel manifest={masterFiles} />

          <Panel title="Certifications">
            {certifications.length === 0 ? (
              <PanelEmpty>No certifications added.</PanelEmpty>
            ) : (
              <ul className="flex flex-col divide-y divide-[var(--separator)]">
                {certifications.map((c, i) => (
                  <li key={`${c.name}-${i}`} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                    <span
                      aria-hidden="true"
                      className="mt-0.5 grid h-[30px] w-[30px] shrink-0 place-items-center rounded-[9px] bg-[var(--tile-green-bg)] text-[var(--tile-green-fg)]"
                    >
                      <IconStar size={15} />
                    </span>
                    <div className="min-w-0">
                      <div className="text-[16px] font-semibold leading-snug text-primary">{c.name}</div>
                      {(c.issuer || c.date) && (
                        <div className="mt-1 text-[14px] text-tertiary">
                          {[c.issuer, c.date].filter(Boolean).join(" · ")}
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          {/* UI-P: the reusable-answers count and a real "Manage saved answers" link to /settings/
           *  answers were added here — the prior version's own comment said no management route
           *  existed, which was true when it was written and is stale now that UI-AM shipped one.
           *  Same unconditional-link precedent Settings' own Applications panel already uses: shown
           *  even at zero, since the destination page has a real, honest empty state of its own. */}
          <Panel title="Application information" description="What Career-Ops reuses when filling in an application.">
            <ul className="flex flex-col gap-2">
              <li className="flex items-start gap-2.5">
                <span aria-hidden="true" className="mt-px text-[var(--pill-success-fg)]">
                  <IconCheckCircle size={16} />
                </span>
                <span className="text-[14px] leading-6 text-primary">
                  Contact details
                  <span className="text-tertiary">
                    {" "}
                    — {[contact.email, contact.phone, contact.location].filter(Boolean).length} of 3 set
                  </span>
                </span>
              </li>
              <li className="flex items-start gap-2.5">
                <span aria-hidden="true" className="mt-px text-[var(--pill-success-fg)]">
                  <IconCheckCircle size={16} />
                </span>
                <span className="text-[14px] leading-6 text-primary">
                  Work authorization
                  <span className="text-tertiary">
                    {" "}
                    — {auth.workAuthorizedUS ? "authorized" : "not authorized"},{" "}
                    {auth.requiresSponsorship ? "sponsorship required" : "no sponsorship needed"}
                  </span>
                </span>
              </li>
            </ul>
            <div className="mt-3 flex items-center justify-between gap-3 rounded-[10px] bg-[var(--z0-bg)] px-3.5 py-3">
              <p className="text-[14px] leading-6 text-primary">
                {settings.applicationAnswers?.count
                  ? `${settings.applicationAnswers.count} saved ${settings.applicationAnswers.count === 1 ? "answer" : "answers"}`
                  : "No saved application answers yet"}
              </p>
              <Link href="/settings/answers" className="shrink-0 text-[14px] font-semibold text-[var(--accent)] hover:underline">
                Manage saved answers
              </Link>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}

/**
 * Skills & evidence.
 *
 * The two groups are the only distinction the data actually carries: every skill on the wire is
 * either attributed to an employer in your history or comes from the Master Skills Inventory alone,
 * and there is no category field. Both counts are stated because they mean different things during
 * tailoring — an employer-backed skill can be claimed directly, an inventory one is used carefully.
 *
 * Search works against the single profile payload already in memory, while the rendered chip list
 * remains capped. Hundreds of persisted skills never become hundreds of hidden DOM nodes.
 */
function SkillsPanel({ employer, inventory }: {
  employer: { rawSkillName: string; attributedTo?: { employer?: string }[] }[];
  inventory: { rawSkillName: string }[];
}) {
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(24);
  const total = employer.length + inventory.length;
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return [
      ...employer.map((skill) => ({ ...skill, provenance: "Resume evidence" as const })),
      ...inventory.map((skill) => ({ ...skill, provenance: "Skills inventory" as const })),
    ].filter((skill) => !needle || skill.rawSkillName.toLowerCase().includes(needle));
  }, [employer, inventory, query]);
  /* Even “Show more” stays capped. Search reaches everything without putting hundreds of hidden or
   * visible chips in the DOM. */
  const MAX_RENDERED = 80;
  const visible = matches.slice(0, Math.min(visibleCount, MAX_RENDERED));

  return (
    <Panel
      title="Skills & evidence"
      description="What Career-Ops can point to when tailoring, drawn from your resume and Master Skills Inventory."
    >
      {total === 0 ? (
        <PanelEmpty
          action={
            <Link href="/master-files" className={BTN_SECONDARY}>
              Add your documents
            </Link>
          }
        >
          No skills on file yet.
        </PanelEmpty>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="rounded-[14px] bg-[var(--tile-green-bg)] px-4 py-4">
              <div className="text-[24px] font-bold leading-none tabular-nums text-[var(--tile-green-fg)]">
                {employer.length}
              </div>
              <div className="mt-2 text-[14px] font-semibold text-primary">Resume evidence</div>
              <div className="mt-1 text-[13px] leading-5 text-tertiary">
                Skills with persisted evidence in your professional history.
              </div>
            </div>
            <div className="rounded-[14px] bg-[var(--tile-blue-bg)] px-4 py-4">
              <div className="text-[24px] font-bold leading-none tabular-nums text-[var(--tile-blue-fg)]">
                {inventory.length}
              </div>
              <div className="mt-2 text-[14px] font-semibold text-primary">Skills inventory</div>
              <div className="mt-1 text-[13px] leading-5 text-tertiary">
                Skills present in your persisted inventory without employer attribution.
              </div>
            </div>
          </div>

          <label className="mt-4 block max-w-[420px]">
            <span className="text-[14px] font-semibold text-secondary">Search skills</span>
            <input
              type="search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setVisibleCount(24);
              }}
              className={`${INPUT} mt-2 min-h-11 text-[15px]`}
              placeholder="Search persisted skills"
            />
          </label>

          <p className="mt-4 text-[13px] text-tertiary">Showing {visible.length} of {matches.length} matching skills.</p>
          {visible.length === 0 ? (
            <p className="mt-3 rounded-[12px] bg-[var(--z0-bg)] px-4 py-5 text-[14px] text-tertiary">No persisted skill matches this search.</p>
          ) : (
            <ul className="mt-3 flex flex-wrap gap-2">
              {visible.map((skill, index) => (
                <li key={`${skill.provenance}-${skill.rawSkillName}-${index}`} className="flex items-center gap-1.5">
                  <Tag>{skill.rawSkillName}</Tag>
                  <span className="sr-only">{skill.provenance}</span>
                </li>
              ))}
            </ul>
          )}

          {visible.length < matches.length && visible.length < MAX_RENDERED && (
            <button type="button" onClick={() => setVisibleCount((count) => Math.min(count + 24, MAX_RENDERED))} className={`${BTN_SECONDARY} mt-4 min-h-11 text-[14px]`}>
              Show more
            </button>
          )}
          {matches.length > MAX_RENDERED && visible.length >= MAX_RENDERED && (
            <p className="mt-3 text-[13px] leading-5 text-tertiary">Search to find skills beyond this bounded view.</p>
          )}
        </>
      )}
    </Panel>
  );
}

function uploadedOn(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime())
    ? d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
    : "an unknown date";
}

/**
 * Career Files — a summary of the two source documents the profile builder reads, not a second
 * upload/manage UI. Reuses the exact manifest /master-files already fetches; this page never writes
 * to it. Real status only: "available" (filename + upload date) or "missing", never "needs review"
 * for a slot this page has no way to independently judge — that distinction belongs to the profile
 * status above, which already covers "the documents changed since the profile was rebuilt" (stale).
 */
function CareerFilesPanel({ manifest }: { manifest: Manifest }) {
  const slots: { key: "resume" | "skills"; label: string }[] = [
    { key: "resume", label: "Master Resume" },
    { key: "skills", label: "Master Skills Inventory" },
  ];
  return (
    <Panel
      title="Career Files"
      description="The source documents your profile is built from."
      actions={
        <Link href="/master-files" className={`${BTN_SECONDARY} min-h-11 text-[14px]`}>
          Manage
        </Link>
      }
    >
      <ul className="flex flex-col divide-y divide-[var(--separator)]">
        {slots.map(({ key, label }) => {
          const entry = manifest[key];
          return (
            <li key={key} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
              <span
                aria-hidden="true"
                className={`mt-0.5 grid h-[30px] w-[30px] shrink-0 place-items-center rounded-[9px] ${
                  entry ? "bg-[var(--tile-green-bg)] text-[var(--tile-green-fg)]" : "bg-[var(--z0-bg)] text-tertiary"
                }`}
              >
                {entry ? <IconCheckCircle size={15} /> : <IconDocument size={15} />}
              </span>
              <div className="min-w-0">
                <div className="text-[15px] font-semibold leading-snug text-primary">{label}</div>
                <div className="mt-1 text-[14px] text-tertiary">
                  {entry ? `${entry.filename} · uploaded ${uploadedOn(entry.uploadedAt)}` : "Not uploaded yet"}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
