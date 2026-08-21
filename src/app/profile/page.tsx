"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useResolvedCandidateId } from "@/lib/useActiveCandidateId";
import {
  BTN_PRIMARY,
  BTN_QUIET,
  BTN_SECONDARY,
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
  IconPin,
  IconShield,
  IconStar,
  IconUser,
} from "@/components/icons";
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
 * Profile — the professional information JobHunt uses.
 *
 * WHAT THIS ROUTE USED TO BE. A `useEffect` that redirected to /candidates/<id>/settings, which is
 * a form. So "Profile" was a place you passed through on the way to editing four fields, and the
 * evidence JobHunt actually reasons over lived on a different route called Candidate Intelligence.
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
 * THREE PAYLOADS, IN PARALLEL, ONCE. No per-section request, no AI call, no polling.
 */

type Loaded = {
  candidate: CandidateRecord;
  evidence: EvidenceProfile | null;
  settings: CandidateSettingsPayload;
};

function fullName(c: CandidateRecord): string {
  return c.display_name?.trim() || [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || "Your profile";
}

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
    <li className="flex items-start gap-2 text-[12.5px] leading-relaxed text-primary">
      <span aria-hidden="true" className="mt-[7px] h-1.5 w-1.5 shrink-0 rotate-45 bg-[var(--accent)]" />
      <span className="min-w-0">{children}</span>
    </li>
  );
}

function EmptyLine({ children }: { children: React.ReactNode }) {
  return <p className="text-[12.5px] leading-relaxed text-tertiary">{children}</p>;
}

/** A figure in the identity strip. Renders zero rather than hiding, so the strip's shape never
 *  depends on the data. `sub` is omitted entirely when there is nothing true to say. */
function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string | null }) {
  return (
    <div className="min-w-0">
      <div className="text-[11.5px] font-semibold uppercase tracking-[0.06em] text-tertiary">{label}</div>
      <div className="mt-1 text-[19px] font-bold leading-none tracking-[-0.015em] tabular-nums text-primary">
        {value}
      </div>
      {sub && <div className="mt-1 truncate text-[11.5px] text-tertiary">{sub}</div>}
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
      const [cRes, pRes, sRes] = await Promise.all([
        fetch(`/api/candidates/${candidateId}`),
        fetch(`/api/candidates/${candidateId}/profile`),
        fetch(`/api/candidates/${candidateId}/settings`),
      ]);
      if (!cRes.ok || !sRes.ok) return setError(true);
      const [cBody, pBody, sBody] = await Promise.all([cRes.json(), pRes.ok ? pRes.json() : null, sRes.json()]);
      setData({
        candidate: cBody.candidate,
        /* A profile that has not been built yet is a real state, not a failure: each panel says so
         * in its own words rather than the page refusing to render. */
        evidence: pBody?.status === "ok" ? (pBody.profile as EvidenceProfile) : null,
        settings: sBody as CandidateSettingsPayload,
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
      <div className="flex flex-col gap-6">
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
      <div className="flex flex-col gap-5">
        <PageHeader
          size="lg"
          title="Profile"
          description="Review the professional information JobHunt uses across matching, resumes, and applications."
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

  const { candidate, evidence, settings } = data;
  const name = fullName(candidate);
  const prefs = settings.preferences;
  const contact = settings.contact;
  const auth = settings.matchAffecting;

  const roleCount = (prefs.primaryTargetRole ? 1 : 0) + prefs.secondaryTargetRoles.length;
  const experience = evidence?.experience ?? [];
  const education = evidence?.education ?? [];
  const certifications = evidence?.certifications ?? [];

  return (
    <div className="flex flex-col gap-5 pb-10">
      <PageHeader
        size="lg"
        title="Profile"
        description="Review the professional information JobHunt uses across matching, resumes, and applications."
        actions={
          /* There is no separate edit route. This opens the section holding the fields it names,
           * rather than navigating to a second place the same values could be typed. */
          <button type="button" onClick={() => setIdentitySignal((n) => n + 1)} className={BTN_PRIMARY}>
            Edit profile
          </button>
        }
      />

      {/* ── identity ─────────────────────────────────────────────────────────────────────────── */}
      {/* Deterministic initials, never a stock photo: the product stores no avatar, and a generated
       *  face would be the one invented thing on a page about being accurate. */}
      <Panel>
        <div className="flex flex-wrap items-start gap-x-5 gap-y-4">
          <span
            aria-hidden="true"
            className="grid h-[56px] w-[56px] shrink-0 place-items-center rounded-full bg-[var(--tile-lav-bg)] text-[20px] font-bold text-[var(--tile-lav-fg)]"
          >
            {initials(name)}
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[21px] font-bold leading-tight tracking-[-0.015em] text-primary">{name}</h2>
            <p className="mt-0.5 text-[13.5px] font-medium text-secondary">
              {prefs.primaryTargetRole ?? <span className="text-tertiary">No target role set</span>}
            </p>
            <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-tertiary">
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
          <button type="button" onClick={() => setIdentitySignal((n) => n + 1)} className={BTN_QUIET}>
            Edit
          </button>
        </div>

        {/* Four real counts. Experience is the builder's own totalYearsExperience — this page never
         *  derives years from date arithmetic the product does not itself do. */}
        <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-4 border-t border-[var(--separator)] pt-4 sm:grid-cols-4">
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
      </Panel>

      {/* ── quick sections ───────────────────────────────────────────────────────────────────── */}
      <h2 className="mt-1 text-[13px] font-bold uppercase tracking-[0.07em] text-tertiary">Quick sections</h2>
      {/* Equal height across the row, as in the reference: four cards of different content
       *  lengths reading as one band rather than a ragged staircase. */}
      <div className="grid grid-cols-1 items-stretch gap-4 sm:grid-cols-2 xl:grid-cols-4 [&>*]:h-full">
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
                  <span className="text-[12px] font-semibold text-secondary">{label}</span>
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
                <span className="text-[12px] font-semibold text-secondary">Primary target role</span>
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
                <span className="text-[12px] font-semibold text-secondary">Also considering</span>
                <input
                  className={INPUT}
                  value={draft.secondaryTargetRoles.join(", ")}
                  placeholder="Azure Data Engineer, AI Engineer"
                  onChange={(e) =>
                    set({ ...draft, secondaryTargetRoles: e.target.value.split(",").map((r) => r.trim()) })
                  }
                />
                <span className="text-[11.5px] text-tertiary">Comma separated. Up to ten.</span>
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
                <span className="text-[12px] font-semibold text-secondary">Preferred location</span>
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
                <legend className="mb-1.5 text-[12px] font-semibold text-secondary">Workplace</legend>
                <div className="flex flex-col gap-1.5">
                  {WORKPLACE_OPTIONS.map((opt) => (
                    <label key={opt} className="flex items-center gap-2 text-[12.5px] text-primary">
                      <input
                        type="checkbox"
                        className="h-[17px] w-[17px] accent-[var(--accent)]"
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
                <span className="text-[12px] font-semibold text-secondary">Employment type</span>
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
              <p className="rounded-[9px] bg-[var(--tile-blue-bg)] px-3 py-2 text-[11.5px] leading-relaxed text-[var(--pill-blue-fg)]">
                Changing these re-evaluates which jobs you&apos;re eligible for.
              </p>
              {(
                [
                  ["workAuthorizedUS", "Authorized to work in the U.S."],
                  ["requiresSponsorship", "I require visa sponsorship"],
                  ["usCitizen", "I am a U.S. citizen"],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="flex items-center gap-2 text-[12.5px] text-primary">
                  <input
                    type="checkbox"
                    className="h-[17px] w-[17px] accent-[var(--accent)]"
                    checked={draft[key]}
                    onChange={(e) => set({ ...draft, [key]: e.target.checked })}
                  />
                  {label}
                </label>
              ))}
              <label className="mt-1 flex flex-col gap-1.5">
                <span className="text-[12px] font-semibold text-secondary">Security clearance</span>
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
      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-2">
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
                No experience on file yet. JobHunt reads this from your master resume.
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
                      <div className="text-[14px] font-bold leading-snug text-primary">{e.title}</div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12.5px] text-secondary">
                        <span>{e.employer}</span>
                        {formatSpan(e.startDate, e.endDate) && (
                          <span className="text-tertiary">· {formatSpan(e.startDate, e.endDate)}</span>
                        )}
                      </div>
                      {/* Technologies, not resume bullets — the bullets are the document's job, and
                       *  what is useful here is what this role can be used as evidence FOR. */}
                      {e.technologies && e.technologies.length > 0 && (
                        <details className="group mt-2">
                          <summary className="cursor-pointer list-none text-[12px] font-semibold text-[var(--accent)] transition-colors duration-150 ease-out hover:text-[var(--accent-hover)]">
                            {e.technologies.length} technologies
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
                    <div className="text-[13.5px] font-bold leading-snug text-primary">
                      {[e.level, e.field].filter(Boolean).join(", ") || e.institution || "Qualification"}
                    </div>
                    {e.institution && <div className="mt-0.5 text-[12.5px] text-tertiary">{e.institution}</div>}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        {/* right: what can be evidenced */}
        <div className="flex flex-col gap-5">
          <SkillsPanel employer={skills.employer} inventory={skills.inventory} />

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
                      <div className="text-[13.5px] font-semibold leading-snug text-primary">{c.name}</div>
                      {(c.issuer || c.date) && (
                        <div className="mt-0.5 text-[12.5px] text-tertiary">
                          {[c.issuer, c.date].filter(Boolean).join(" · ")}
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          {/* Keeps the reference's slot. What it does NOT have is a saved-answers list or a Manage
           *  answers control: the answer store is empty and no management route exists, so both
           *  would be controls that lead nowhere. It states that, and shows what IS reused. */}
          <Panel title="Application information" description="What JobHunt reuses when filling in an application.">
            <ul className="flex flex-col gap-2">
              <li className="flex items-start gap-2.5">
                <span aria-hidden="true" className="mt-px text-[var(--pill-success-fg)]">
                  <IconCheckCircle size={16} />
                </span>
                <span className="text-[12.5px] leading-relaxed text-primary">
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
                <span className="text-[12.5px] leading-relaxed text-primary">
                  Work authorization
                  <span className="text-tertiary">
                    {" "}
                    — {auth.workAuthorizedUS ? "authorized" : "not authorized"},{" "}
                    {auth.requiresSponsorship ? "sponsorship required" : "no sponsorship needed"}
                  </span>
                </span>
              </li>
            </ul>
            <div className="mt-3 rounded-[10px] bg-[var(--z0-bg)] px-3.5 py-3">
              <p className="text-[12.5px] leading-relaxed text-tertiary">
                No reusable application answers saved yet. Answers you give during an application are
                stored so JobHunt can offer them again.
              </p>
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
 * "View all skills" expands in place rather than linking out: the full list is already in the
 * payload this page loaded, and no other route displays it.
 */
function SkillsPanel({
  employer,
  inventory,
}: {
  employer: { rawSkillName: string; attributedTo?: { employer?: string }[] }[];
  inventory: { rawSkillName: string }[];
}) {
  const [showAll, setShowAll] = useState(false);
  const PREVIEW = 24;
  const total = employer.length + inventory.length;

  return (
    <Panel
      title="Skills & evidence"
      description="What JobHunt can point to when tailoring, drawn from your resume and Master Skills Inventory."
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
            <div className="rounded-[10px] bg-[var(--tile-green-bg)] px-3.5 py-3">
              <div className="text-[19px] font-bold leading-none tabular-nums text-[var(--tile-green-fg)]">
                {employer.length}
              </div>
              <div className="mt-1.5 text-[12px] font-semibold text-primary">Backed by an employer</div>
              <div className="mt-0.5 text-[11.5px] leading-snug text-tertiary">
                Attached to a role you held, so a resume can claim it directly.
              </div>
            </div>
            <div className="rounded-[10px] bg-[var(--tile-blue-bg)] px-3.5 py-3">
              <div className="text-[19px] font-bold leading-none tabular-nums text-[var(--tile-blue-fg)]">
                {inventory.length}
              </div>
              <div className="mt-1.5 text-[12px] font-semibold text-primary">From your skills inventory</div>
              <div className="mt-0.5 text-[11.5px] leading-snug text-tertiary">
                Listed by you without an employer attached. Used more carefully.
              </div>
            </div>
          </div>

          <div className="mt-3.5 flex flex-wrap gap-1.5">
            {(showAll ? employer : employer.slice(0, PREVIEW)).map((s, i) => (
              <span
                key={`${s.rawSkillName}-${i}`}
                title={
                  s.attributedTo && s.attributedTo.length > 0
                    ? s.attributedTo.map((a) => a.employer).filter(Boolean).join(", ")
                    : undefined
                }
              >
                <Tag>{s.rawSkillName}</Tag>
              </span>
            ))}
          </div>

          {showAll && inventory.length > 0 && (
            <div className="mt-3.5">
              <div className="mb-2 text-[12px] font-semibold text-secondary">From your skills inventory</div>
              <div className="flex flex-wrap gap-1.5">
                {inventory.map((s, i) => (
                  <Tag key={`${s.rawSkillName}-${i}`}>{s.rawSkillName}</Tag>
                ))}
              </div>
            </div>
          )}

          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="mt-2.5 inline-flex min-h-[32px] items-center text-[12.5px] font-semibold text-[var(--accent)] transition-colors duration-150 ease-out hover:text-[var(--accent-hover)]"
          >
            {showAll ? "Show fewer skills" : `View all ${total} skills`}
          </button>
        </>
      )}
    </Panel>
  );
}
