"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useResolvedCandidateId } from "@/lib/useActiveCandidateId";
import {
  BTN_PRIMARY,
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
  IconBell,
  IconBriefcase,
  IconCheckCircle,
  IconDocument,
  IconShield,
  IconSparkle,
} from "@/components/icons";
import {
  NOTIFICATION_PRESENTATION,
  NOTIFICATION_TYPE_ORDER,
} from "@/lib/notifications/presentation";
import { SETTINGS_CATEGORIES, type SettingsCategoryId } from "./categories";
import {
  CLEARANCE_OPTIONS,
  EMPLOYMENT_OPTIONS,
  WORKPLACE_OPTIONS,
  type CandidateSettingsPayload,
  type PreferenceValues,
  type WorkAuthValues,
} from "../profile/types";

/**
 * Settings — how JobHunt searches, notifies, and helps you apply.
 *
 * WHAT THIS ROUTE USED TO BE. A page titled "Control Center" holding scanner timeouts, retry
 * backoff, ATS concurrency, archive/delete thresholds and suppression windows. Those are operator
 * controls that change behaviour for every profile; they now live at /admin/settings, unchanged,
 * behind the same API. What is left here is the set of things that actually belong to a person.
 *
 * EVERY CONTROL ON THIS PAGE WRITES SOMETHING. Two of the five categories deliberately render no
 * interactive control at all: the product has no notification-preference store and no Copilot
 * preference store, so a switch in either place could only pretend. The reference for this screen
 * shows toggles in both; a toggle that silently forgets is worse than an honest read-only row, and
 * it teaches you that the rest of the page's switches might be decorative too. They show the real
 * categories and the real state, and say plainly that preferences are not configurable yet.
 *
 * The same rule removed three rows from Data & Privacy. Export data, clear saved answers and delete
 * generated documents have no server action behind them; they are not rendered as disabled buttons
 * either, because a disabled button still advertises a capability.
 */

interface AppSettingsShape {
  lifecycle: { freshDays: number };
  scheduler: { writerEnabled: boolean; enabled: boolean };
}

interface CandidateRecord {
  id: number;
  display_name: string | null;
  is_owner: number;
  has_pin: number;
}

type Loaded = {
  candidate: CandidateRecord;
  settings: CandidateSettingsPayload & { applicationAnswers?: { count: number } };
  app: AppSettingsShape | null;
};

/** A row in the category rail. Active is lavender + indigo, matching the shell's own nav. */
function RailItem({
  active,
  label,
  icon,
  onClick,
}: {
  active: boolean;
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`flex h-[42px] w-full items-center gap-2.5 rounded-[10px] px-3 text-[13.5px] font-medium transition-colors duration-150 ease-out active:scale-[0.99] ${
        active
          ? "bg-[var(--tile-lav-bg)] text-[var(--accent)]"
          : "text-secondary hover:bg-[var(--surface-hover)] hover:text-primary"
      }`}
    >
      <span aria-hidden="true" className="shrink-0">
        {icon}
      </span>
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}

const CATEGORY_ICONS: Record<SettingsCategoryId, React.ReactNode> = {
  "job-search": <IconBriefcase size={17} />,
  notifications: <IconBell size={17} />,
  applications: <IconDocument size={17} />,
  "career-copilot": <IconSparkle size={17} />,
  "data-privacy": <IconShield size={17} />,
};

/** A labelled block inside a settings panel. Form controls are capped so a field never spans the
 *  whole of a 2,000px display; the panel itself still uses the width. */
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-[var(--separator)] py-4 first:pt-0 last:border-b-0 last:pb-0">
      <div className="text-[13px] font-semibold text-primary">{label}</div>
      {hint && <p className="mt-1 max-w-[68ch] text-[12.5px] leading-relaxed text-tertiary">{hint}</p>}
      <div className="mt-2.5 max-w-[560px]">{children}</div>
    </div>
  );
}

export default function SettingsPage() {
  const candidateId = useResolvedCandidateId();
  const [category, setCategory] = useState<SettingsCategoryId>("job-search");
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    if (candidateId === null) return;
    setError(false);
    try {
      const [cRes, sRes, aRes] = await Promise.all([
        fetch(`/api/candidates/${candidateId}`),
        fetch(`/api/candidates/${candidateId}/settings`),
        fetch("/api/settings"),
      ]);
      if (!cRes.ok || !sRes.ok) return setError(true);
      const [cBody, sBody, aBody] = await Promise.all([cRes.json(), sRes.json(), aRes.ok ? aRes.json() : null]);
      setData({
        candidate: cBody.candidate,
        settings: sBody,
        app: aBody?.settings ?? aBody ?? null,
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

  const active = SETTINGS_CATEGORIES.find((c) => c.id === category)!;

  if (error) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader size="lg" title="Settings" />
        <Panel>
          <PanelEmpty
            action={
              <button type="button" onClick={load} className={BTN_SECONDARY}>
                Retry
              </button>
            }
          >
            We couldn&apos;t load settings.
          </PanelEmpty>
        </Panel>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 pb-10">
      <PageHeader
        size="lg"
        title="Settings"
        description="Control how JobHunt searches, notifies you, and assists with applications."
        actions={
          /* Owner only, and deliberately quiet: system settings are a different job, not a louder
           *  version of this page. Non-owners never see the route exists. */
          data?.candidate.is_owner === 1 ? (
            <Link href="/admin/settings" className={BTN_SECONDARY}>
              System settings
            </Link>
          ) : null
        }
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[236px_minmax(0,1fr)]">
        {/* ── category rail ──────────────────────────────────────────────────────────────────── */}
        {/* Horizontal and scrollable below lg, a persistent rail above it. A 236px column on a
         *  390px screen would leave 150px for the panel it controls. */}
        <nav aria-label="Settings categories" className="lg:sticky lg:top-2 lg:self-start">
          <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0 lg:pb-0">
            {SETTINGS_CATEGORIES.map((c) => (
              <div key={c.id} className="shrink-0 lg:shrink lg:w-full">
                <RailItem
                  active={c.id === category}
                  label={c.label}
                  icon={CATEGORY_ICONS[c.id]}
                  onClick={() => setCategory(c.id)}
                />
              </div>
            ))}
          </div>
        </nav>

        {/* ── panel ──────────────────────────────────────────────────────────────────────────── */}
        <div className="min-w-0">
          {candidateId === null || data === null ? (
            <>
              <LoadingRegion label="Loading settings" />
              <Panel>
                <SkeletonRows rows={6} />
              </Panel>
            </>
          ) : (
            <div className="flex flex-col gap-5">
              {category === "job-search" && (
                <JobSearchPanel
                  candidateId={candidateId}
                  blurb={active.blurb}
                  settings={data.settings}
                  freshDays={data.app?.lifecycle?.freshDays ?? null}
                  onSaved={load}
                />
              )}
              {category === "notifications" && <NotificationsPanel blurb={active.blurb} />}
              {category === "applications" && (
                <ApplicationsPanel
                  blurb={active.blurb}
                  writerEnabled={data.app?.scheduler?.writerEnabled ?? null}
                  automationEnabled={data.app?.scheduler?.enabled ?? null}
                  savedAnswers={data.settings.applicationAnswers?.count ?? null}
                  onSaved={load}
                />
              )}
              {category === "career-copilot" && <CareerCopilotPanel blurb={active.blurb} />}
              {category === "data-privacy" && (
                <DataPrivacyPanel blurb={active.blurb} candidate={data.candidate} />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Job Search ─────────────────────────────────────────────────────────────────────────────── */

/**
 * The only panel on this page that edits several values at once, so it is the only one with an
 * explicit Save. Sponsorship sits here with the rest of the search because that is what it does —
 * but it writes the match-affecting bucket, and re-running eligibility is stated before you save
 * rather than discovered afterwards.
 */
function JobSearchPanel({
  candidateId,
  blurb,
  settings,
  freshDays,
  onSaved,
}: {
  candidateId: number;
  blurb: string;
  settings: CandidateSettingsPayload;
  freshDays: number | null;
  onSaved: () => Promise<void>;
}) {
  const [prefs, setPrefs] = useState<PreferenceValues>(settings.preferences);
  const [auth, setAuth] = useState<WorkAuthValues>(settings.matchAffecting);
  const [roleDraft, setRoleDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const dirty = useMemo(
    () =>
      JSON.stringify(prefs) !== JSON.stringify(settings.preferences) ||
      JSON.stringify(auth) !== JSON.stringify(settings.matchAffecting),
    [prefs, auth, settings]
  );

  // Deduplicated for display, order preserved: primaryTargetRole can also appear in
  // secondaryTargetRoles (upstream data, not reshaped here), which used to render the same chip
  // twice with a duplicate React key.
  const roles = Array.from(new Set([prefs.primaryTargetRole, ...prefs.secondaryTargetRoles].filter(Boolean))) as string[];

  function removeRole(role: string) {
    if (role === prefs.primaryTargetRole) {
      const [next, ...rest] = prefs.secondaryTargetRoles;
      setPrefs({ ...prefs, primaryTargetRole: next ?? null, secondaryTargetRoles: rest });
    } else {
      setPrefs({ ...prefs, secondaryTargetRoles: prefs.secondaryTargetRoles.filter((r) => r !== role) });
    }
    setSaved(false);
  }

  function addRole() {
    const v = roleDraft.trim();
    if (!v || roles.includes(v)) return;
    if (!prefs.primaryTargetRole) setPrefs({ ...prefs, primaryTargetRole: v });
    else setPrefs({ ...prefs, secondaryTargetRoles: [...prefs.secondaryTargetRoles, v] });
    setRoleDraft("");
    setSaved(false);
  }

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch(`/api/candidates/${candidateId}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ preferences: prefs, matchAffecting: auth }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        throw new Error(
          (Array.isArray(d?.errors) ? d.errors[0]?.message : null) ??
            "We couldn't save these settings. Nothing was changed."
        );
      }
      await onSaved();
      setSaved(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "We couldn't save these settings.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Panel title="Job Search" description={blurb}>
        <Field label="Target roles" hint="These drive the For You feed and the role scope filter on Jobs.">
          <div className="flex flex-wrap items-center gap-2">
            {roles.length === 0 && <span className="text-[12.5px] text-tertiary">No target roles set.</span>}
            {roles.map((r) => (
              <span
                key={r}
                className="inline-flex h-[34px] items-center gap-1 rounded-full bg-[var(--tile-lav-bg)] pl-3.5 pr-1 text-[12.5px] font-medium text-[var(--accent)]"
              >
                {r}
                <button
                  type="button"
                  onClick={() => removeRole(r)}
                  aria-label={`Remove ${r}`}
                  className="grid h-[28px] w-[28px] place-items-center rounded-full text-[15px] leading-none transition-colors duration-150 ease-out hover:bg-[var(--accent-soft)]"
                >
                  <span aria-hidden="true">×</span>
                </button>
              </span>
            ))}
          </div>
          <div className="mt-2.5 flex flex-wrap gap-2">
            <input
              className={`${INPUT} max-w-[260px]`}
              value={roleDraft}
              placeholder="Add a role"
              aria-label="Add a target role"
              onChange={(e) => setRoleDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addRole();
                }
              }}
            />
            <button type="button" onClick={addRole} disabled={!roleDraft.trim()} className={BTN_SECONDARY}>
              Add role
            </button>
          </div>
          {roles.length > 0 && (
            <p className="mt-2 text-[11.5px] text-tertiary">
              The first is your primary role: <span className="font-medium text-secondary">{roles[0]}</span>.
            </p>
          )}
        </Field>

        <Field label="Location preference">
          <input
            className={`${INPUT} max-w-[320px]`}
            aria-label="Location preference"
            value={prefs.locationPreference ?? ""}
            placeholder="Dallas, TX"
            onChange={(e) => {
              setPrefs({ ...prefs, locationPreference: e.target.value.trim() === "" ? null : e.target.value });
              setSaved(false);
            }}
          />
        </Field>

        {/* Checkboxes, not radios: the stored value is a list of up to ten, and rendering it as a
         *  single choice would silently discard two of your three current selections. */}
        <Field label="Workplace type" hint="Choose as many as you'd consider.">
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            {WORKPLACE_OPTIONS.map((opt) => (
              <label key={opt} className="flex items-center gap-2 text-[13px] text-primary">
                <input
                  type="checkbox"
                  className="h-[17px] w-[17px] accent-[var(--accent)]"
                  checked={prefs.workplacePreference.includes(opt)}
                  onChange={(e) => {
                    setPrefs({
                      ...prefs,
                      workplacePreference: e.target.checked
                        ? [...prefs.workplacePreference, opt]
                        : prefs.workplacePreference.filter((w) => w !== opt),
                    });
                    setSaved(false);
                  }}
                />
                {opt}
              </label>
            ))}
          </div>
        </Field>

        <Field label="Employment type">
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            {EMPLOYMENT_OPTIONS.map((opt) => (
              <label key={opt} className="flex items-center gap-2 text-[13px] text-primary">
                <input
                  type="radio"
                  name="employment-type"
                  className="h-[17px] w-[17px] accent-[var(--accent)]"
                  checked={prefs.employmentTypePreference === opt}
                  onChange={() => {
                    setPrefs({ ...prefs, employmentTypePreference: opt });
                    setSaved(false);
                  }}
                />
                {opt}
              </label>
            ))}
          </div>
        </Field>

        {/* Worded as the fact you are stating, not as a filter you are switching on. JobHunt never
         *  reads an unknown sponsorship policy as "sponsors" — that logic is untouched by this. */}
        <Field
          label="Sponsorship"
          hint="Saying you require sponsorship re-evaluates which jobs you're eligible for. A posting that says nothing about sponsorship is never treated as offering it."
        >
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2 text-[13px] text-primary">
              <input
                type="checkbox"
                className="h-[17px] w-[17px] accent-[var(--accent)]"
                checked={auth.requiresSponsorship}
                onChange={(e) => {
                  setAuth({ ...auth, requiresSponsorship: e.target.checked });
                  setSaved(false);
                }}
              />
              I require visa sponsorship
            </label>
            <label className="flex items-center gap-2 text-[13px] text-primary">
              <input
                type="checkbox"
                className="h-[17px] w-[17px] accent-[var(--accent)]"
                checked={auth.workAuthorizedUS}
                onChange={(e) => {
                  setAuth({ ...auth, workAuthorizedUS: e.target.checked });
                  setSaved(false);
                }}
              />
              I&apos;m authorized to work in the U.S.
            </label>
          </div>
        </Field>

        <Field label="Security clearance">
          <select
            className={`${INPUT} max-w-[240px]`}
            aria-label="Security clearance"
            value={auth.clearanceLevel}
            onChange={(e) => {
              setAuth({ ...auth, clearanceLevel: e.target.value });
              setSaved(false);
            }}
          >
            {CLEARANCE_OPTIONS.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </Field>

        <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
          {err && (
            <p role="alert" className="mr-auto text-[12.5px] text-[var(--error)]">
              {err}
            </p>
          )}
          {saved && !err && (
            <p aria-live="polite" className="mr-auto text-[12.5px] font-medium text-[var(--pill-success-fg)]">
              Saved.
            </p>
          )}
          <button type="button" onClick={save} disabled={saving || !dirty} className={BTN_PRIMARY}>
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </Panel>

      {/* The summary reads the SAVED values, never the draft — otherwise it would describe a search
       *  you have not committed to. Freshness is shown but not editable here: it is one global
       *  number shared by every profile, and it lives with the other operator settings. */}
      <Panel title="Current search summary" description="What your feed is filtered by right now.">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
          <SummaryRow
            label="Target roles"
            value={
              [settings.preferences.primaryTargetRole, ...settings.preferences.secondaryTargetRoles]
                .filter(Boolean)
                .join(", ") || null
            }
          />
          <SummaryRow label="Location" value={settings.preferences.locationPreference} />
          <SummaryRow label="Workplace" value={settings.preferences.workplacePreference.join(" · ") || null} />
          <SummaryRow label="Employment type" value={settings.preferences.employmentTypePreference} />
          <SummaryRow
            label="Sponsorship"
            value={settings.matchAffecting.requiresSponsorship ? "Required" : "Not required"}
          />
          <SummaryRow
            label="Freshness"
            value={freshDays !== null ? `Jobs under ${freshDays} days old are highlighted` : null}
          />
        </dl>
      </Panel>
    </>
  );
}

function SummaryRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11.5px] font-semibold uppercase tracking-[0.06em] text-tertiary">{label}</dt>
      <dd className="mt-1 text-[13px] leading-relaxed text-primary">
        {value ?? <span className="text-tertiary">Not set</span>}
      </dd>
    </div>
  );
}

/* ── Notifications ──────────────────────────────────────────────────────────────────────────── */

/**
 * Read-only, and says so.
 *
 * There is no notification-preference store: `notifications` has a type and a read timestamp and
 * nothing else, and no table records what a person wants to receive. Every category below is
 * therefore genuinely on, which is exactly what "Active" claims. Rendering the reference's switches
 * would mean either dropping the change on the floor or inventing a schema during a visual pass.
 */
function NotificationsPanel({ blurb }: { blurb: string }) {
  return (
    <Panel title="Notifications" description={blurb}>
      <ul className="flex flex-col">
        {NOTIFICATION_TYPE_ORDER.map((type) => {
          const p = NOTIFICATION_PRESENTATION[type]!;
          return (
            <li
              key={type}
              className="flex items-start justify-between gap-4 border-b border-[var(--separator)] py-3.5 first:pt-0 last:border-b-0 last:pb-0"
            >
              <div className="min-w-0">
                <div className="text-[13px] font-semibold text-primary">{p.title}</div>
                <p className="mt-0.5 text-[12.5px] leading-relaxed text-tertiary">{p.description}</p>
              </div>
              <Pill tone="success">
                <IconCheckCircle size={13} aria-hidden="true" />
                Active
              </Pill>
            </li>
          );
        })}
      </ul>
      <div className="mt-4 rounded-[10px] bg-[var(--z0-bg)] px-4 py-3">
        <p className="text-[12.5px] leading-relaxed text-tertiary">
          You currently receive all of these. Choosing which ones to get, and how often, isn&apos;t
          available yet — so there&apos;s nothing to switch here rather than a switch that
          wouldn&apos;t stick.
        </p>
      </div>
    </Panel>
  );
}

/* ── Applications ───────────────────────────────────────────────────────────────────────────── */

/**
 * Two real controls and one deliberate non-control.
 *
 * The resume writer toggle writes a real setting and is the only one that spends the Claude
 * subscription, so turning it ON asks for confirmation and states what will happen. Final approval
 * is rendered as a locked fact, not a switch: the engine requires a person to approve every
 * submission, and a settings page that appeared able to turn that off would be describing a product
 * that does not exist.
 */
function ApplicationsPanel({
  blurb,
  writerEnabled,
  automationEnabled,
  savedAnswers,
  onSaved,
}: {
  blurb: string;
  writerEnabled: boolean | null;
  automationEnabled: boolean | null;
  savedAnswers: number | null;
  onSaved: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function setWriter(next: boolean) {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scheduler: { writerEnabled: next } }),
      });
      if (!res.ok) throw new Error("We couldn't change this. Nothing was changed.");
      await onSaved();
      setConfirming(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "We couldn't change this.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Panel title="Applications" description={blurb}>
        <Field
          label="Resume writer"
          hint="Whether JobHunt may write tailored resumes in the background for jobs you have already approved. It approves nothing, creates no new tailoring work, and never submits an application. Turning it off stops new work being picked up on the next pass; a pass already running finishes."
        >
          {writerEnabled === null ? (
            <p className="text-[12.5px] text-tertiary">Not available.</p>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <Pill tone={writerEnabled ? "success" : "neutral"}>{writerEnabled ? "On" : "Off"}</Pill>
              {writerEnabled ? (
                <button type="button" onClick={() => setWriter(false)} disabled={busy} className={BTN_SECONDARY}>
                  {busy ? "Saving…" : "Turn off"}
                </button>
              ) : confirming ? (
                <>
                  <button type="button" onClick={() => setWriter(true)} disabled={busy} className={BTN_PRIMARY}>
                    {busy ? "Saving…" : "Confirm — start writing"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(false)}
                    disabled={busy}
                    className={BTN_SECONDARY}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button type="button" onClick={() => setConfirming(true)} disabled={busy} className={BTN_SECONDARY}>
                  Turn on
                </button>
              )}
            </div>
          )}
          {confirming && !writerEnabled && (
            <p className="mt-2.5 max-w-[68ch] text-[12.5px] leading-relaxed text-[var(--pill-amber-fg)]">
              Jobs you have already approved will begin being written on the next scheduled pass,
              using your Claude subscription. You still review and send every application yourself.
            </p>
          )}
          {automationEnabled === false && writerEnabled && (
            <p className="mt-2.5 text-[12.5px] leading-relaxed text-tertiary">
              Background automation is currently off, so nothing will run until it&apos;s enabled in
              system settings.
            </p>
          )}
          {err && (
            <p role="alert" className="mt-2 text-[12.5px] text-[var(--error)]">
              {err}
            </p>
          )}
        </Field>

        {/* Not a toggle, and never will be one. */}
        <Field label="Final approval">
          <div className="flex items-start gap-2.5 rounded-[10px] bg-[var(--tile-green-bg)] px-4 py-3">
            <span aria-hidden="true" className="mt-px shrink-0 text-[var(--pill-success-fg)]">
              <IconShield size={17} />
            </span>
            <div className="min-w-0">
              <div className="text-[13px] font-semibold text-[var(--pill-success-fg)]">
                Always required before submission
              </div>
              <p className="mt-1 max-w-[68ch] text-[12.5px] leading-relaxed text-secondary">
                JobHunt fills in what it can evidence and stops for anything it cannot. Nothing is
                ever submitted to an employer until you approve it, and there is no setting that
                changes that.
              </p>
            </div>
          </div>
        </Field>

        <Field
          label="Saved application answers"
          hint="Answers you give during an application are kept so JobHunt can offer them again on a similar question."
        >
          {savedAnswers === null ? (
            <p className="text-[12.5px] text-tertiary">Not available.</p>
          ) : savedAnswers === 0 ? (
            <p className="text-[12.5px] leading-relaxed text-tertiary">
              No reusable answers saved yet. They appear here once you answer a question during an
              application.
            </p>
          ) : (
            <p className="text-[13px] text-primary">
              <span className="font-semibold tabular-nums">{savedAnswers}</span>{" "}
              {savedAnswers === 1 ? "answer" : "answers"} saved.
            </p>
          )}
        </Field>
      </Panel>
    </>
  );
}

/* ── Career Copilot ─────────────────────────────────────────────────────────────────────────── */

function CareerCopilotPanel({ blurb }: { blurb: string }) {
  return (
    <Panel title="Career Copilot" description={blurb}>
      <div className="flex flex-col items-center gap-3 rounded-[12px] bg-[var(--z0-bg)] px-6 py-10 text-center">
        <span
          aria-hidden="true"
          className="grid h-[52px] w-[52px] place-items-center rounded-full bg-[var(--tile-lav-bg)] text-[var(--tile-lav-fg)]"
        >
          <IconSparkle size={24} />
        </span>
        <h3 className="text-[15px] font-bold text-primary">Career Copilot</h3>
        <p className="max-w-[46ch] text-[12.5px] leading-relaxed text-tertiary">
          Ask why a job matches your evidence, from any job. Copilot answers from your own profile
          and resumes — it runs only when you ask it something, never on its own.
        </p>
        {/* No provider, model or key configuration: that is developer setup, not a candidate
         *  preference, and it would put credentials on a candidate-facing page. */}
        <Pill tone="neutral">Not configurable yet</Pill>
      </div>
    </Panel>
  );
}

/* ── Data & Privacy ─────────────────────────────────────────────────────────────────────────── */

/**
 * Only what the server can actually do.
 *
 * The reference offers export, clear-saved-answers and delete-generated-documents. None has a
 * server action, so none is rendered — not even greyed out, because a disabled control still
 * advertises a capability and invites a support question.
 *
 * Delete is real but refuses the owner and refuses the last remaining profile. Rather than let you
 * press it and receive a 409, the button carries the reason it cannot run.
 */
function DataPrivacyPanel({ blurb, candidate }: { blurb: string; candidate: CandidateRecord }) {
  const isOwner = candidate.is_owner === 1;

  return (
    <>
      <Panel title="Data & Privacy" description={blurb}>
        <Field
          label="Profile PIN"
          hint="A four-digit PIN keeps this profile's jobs, resumes and applications from being opened by anyone who walks up to this browser."
        >
          <div className="flex flex-wrap items-center gap-3">
            <Pill tone={candidate.has_pin ? "success" : "warning"}>
              {candidate.has_pin ? "PIN set" : "No PIN"}
            </Pill>
            <Link href={`/candidates/${candidate.id}/settings`} className={BTN_SECONDARY}>
              {candidate.has_pin ? "Change PIN" : "Set a PIN"}
            </Link>
          </div>
        </Field>

        <Field label="What JobHunt stores" hint="Everything stays on this machine — there is no JobHunt account and nothing is uploaded.">
          <ul className="flex flex-col gap-1.5">
            {[
              "Your master resume and skills inventory",
              "Jobs scanned, and how each one matched your evidence",
              "Tailored resumes and their validation history",
              "Answers you give during an application",
            ].map((t) => (
              <li key={t} className="flex items-start gap-2 text-[12.5px] leading-relaxed text-secondary">
                <span aria-hidden="true" className="mt-[7px] h-1.5 w-1.5 shrink-0 rotate-45 bg-[var(--accent)]" />
                {t}
              </li>
            ))}
          </ul>
        </Field>
      </Panel>

      <section
        aria-label="Danger zone"
        className="rounded-[14px] border border-[var(--pill-red-fg)]/35 bg-[var(--z3-bg)] px-5 py-[18px]"
      >
        <h2 className="text-[15px] font-bold tracking-[-0.01em] text-[var(--pill-red-fg)]">Danger zone</h2>
        <div className="mt-3.5 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 max-w-[62ch]">
            <div className="text-[13px] font-semibold text-primary">Delete this profile</div>
            <p className="mt-1 text-[12.5px] leading-relaxed text-tertiary">
              Permanently removes this profile and everything attached to it — matches, tailored
              resumes, applications and saved answers. Scanned jobs and companies are shared and stay.
            </p>
            {isOwner && (
              <p className="mt-2 text-[12.5px] leading-relaxed text-[var(--pill-amber-fg)]">
                This is the owner profile, which can&apos;t be deleted. Another profile can be
                removed from the profile switcher.
              </p>
            )}
          </div>
          <button
            type="button"
            disabled
            title={
              isOwner
                ? "The owner profile cannot be deleted."
                : "Deleting a profile is done from the profile switcher."
            }
            className="inline-flex h-[42px] shrink-0 cursor-not-allowed items-center rounded-[9px] border border-[var(--pill-red-fg)]/35 px-4 text-[13px] font-semibold text-[var(--pill-red-fg)] opacity-50"
          >
            Delete profile
          </button>
        </div>
      </section>
    </>
  );
}
