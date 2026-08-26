"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useResolvedCandidateId } from "@/lib/useActiveCandidateId";
import {
  BTN_SECONDARY,
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
  IconSettings,
  IconShield,
  IconSparkle,
} from "@/components/icons";
import {
  NOTIFICATION_PRESENTATION,
  NOTIFICATION_TYPE_ORDER,
} from "@/lib/notifications/presentation";
import {
  readStoredThemePreference,
  setThemePreference,
  type ThemePreference,
} from "@/lib/theme";
import { isSettingsCategory, SETTINGS_CATEGORIES, type SettingsCategoryId } from "./categories";
import {
  type CandidateSettingsPayload,
} from "../profile/types";

/**
 * Settings — how Career-Ops searches, notifies, and helps you apply.
 *
 * WHAT THIS ROUTE USED TO BE. A page titled "Control Center" holding scanner timeouts, retry
 * backoff, ATS concurrency, archive/delete thresholds and suppression windows. Those are operator
 * controls that change behaviour for every profile; they now live at /admin/settings, unchanged,
 * behind the same API. What is left here is the set of things that actually belong to a person.
 *
 * EVERY CONTROL ON THIS PAGE HAS A REAL DESTINATION. Professional facts have one edit home in
 * Profile; Settings summarizes them and links there. Notification and Copilot preferences have no
 * persistence contract, so those categories describe the real behavior instead of rendering
 * switches that would silently forget the candidate's choice.
 *
 * Export data, clear saved answers, generated-document deletion, and profile deletion are not
 * advertised here because this batch adds no destructive or persistence behavior.
 */

interface CandidateRecord {
  id: number;
  display_name: string | null;
  is_owner: number;
  has_pin: number;
}

type Loaded = {
  candidate: CandidateRecord;
  settings: CandidateSettingsPayload;
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
      className={`flex min-h-11 w-full items-center gap-3 rounded-[11px] px-3.5 text-[15px] font-medium transition-colors duration-150 ease-out active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] ${
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
  "job-search": <IconBriefcase size={20} />,
  notifications: <IconBell size={20} />,
  applications: <IconDocument size={20} />,
  "career-copilot": <IconSparkle size={20} />,
  appearance: <IconSettings size={20} />,
  "data-privacy": <IconShield size={20} />,
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
    <div className="border-b border-[var(--separator)] py-5 first:pt-0 last:border-b-0 last:pb-0">
      <div className="text-[16px] font-semibold text-primary">{label}</div>
      {hint && <p className="mt-1 max-w-[68ch] text-[14px] leading-6 text-tertiary">{hint}</p>}
      <div className="mt-3 max-w-[620px]">{children}</div>
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
      const [cRes, sRes] = await Promise.all([
        fetch(`/api/candidates/${candidateId}`),
        fetch(`/api/candidates/${candidateId}/settings`),
      ]);
      if (!cRes.ok || !sRes.ok) return setError(true);
      const [cBody, sBody] = await Promise.all([cRes.json(), sRes.json()]);
      setData({
        candidate: cBody.candidate,
        settings: sBody,
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

  /* UI-AM — `isSettingsCategory` already existed (categories.ts) but nothing read the URL, so a
   * link like `/settings?category=applications` silently landed on the default tab instead — a
   * fake-looking deep link is exactly what this phase was told never to ship. Read via
   * window.location.search in an effect (not useSearchParams) so this page needs no Suspense
   * boundary; an invalid or absent value leaves the existing default untouched. */
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("category");
    if (requested && isSettingsCategory(requested)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCategory(requested);
    }
  }, []);

  const active = SETTINGS_CATEGORIES.find((c) => c.id === category)!;

  if (error) {
    return (
      <div className="mx-auto flex w-full max-w-[var(--candidate-page-max)] flex-col gap-6">
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
    <div className="mx-auto flex w-full max-w-[var(--candidate-page-max)] flex-col gap-6 pb-12">
      <PageHeader
        size="lg"
        title="Settings"
        description="Choose how Career-Ops behaves for your search, applications, and privacy."
      />

      <div className="grid grid-cols-1 gap-5 lg:min-h-[calc(100dvh-var(--workspace-chrome)-8rem)] lg:grid-cols-[270px_minmax(0,1fr)] lg:items-stretch lg:gap-5">
        {/* ── category rail ──────────────────────────────────────────────────────────────────── */}
        {/* Horizontal and scrollable below lg, a persistent rail above it. A 236px column on a
         *  390px screen would leave 150px for the panel it controls. */}
        <nav aria-label="Settings categories" className="lg:sticky lg:top-2 lg:h-fit lg:min-h-full lg:rounded-[18px] lg:border lg:border-[var(--border)] lg:bg-[var(--z3-bg)] lg:p-3 lg:shadow-[var(--lift-1)]">
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
        <div className="min-w-0 lg:min-h-full">
          {candidateId === null || data === null ? (
            <>
              <LoadingRegion label="Loading settings" />
              <Panel>
                <SkeletonRows rows={6} />
              </Panel>
            </>
          ) : (
            <div className="flex flex-col gap-5 lg:min-h-full [&>.candidate-panel]:lg:flex-1">
              {category === "job-search" && (
                <JobSearchPanel blurb={active.blurb} settings={data.settings} />
              )}
              {category === "notifications" && <NotificationsPanel blurb={active.blurb} />}
              {category === "applications" && (
                <ApplicationsPanel
                  blurb={active.blurb}
                  savedAnswers={data.settings.applicationAnswers?.count ?? null}
                />
              )}
              {category === "career-copilot" && <CareerCopilotPanel blurb={active.blurb} />}
              {category === "appearance" && <AppearancePanel blurb={active.blurb} />}
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

/** Search facts belong to Profile. Settings reads the same persisted values and links to their one
 * edit home instead of maintaining a second draft with subtly different role-removal behavior. */
function JobSearchPanel({ blurb, settings }: { blurb: string; settings: CandidateSettingsPayload }) {
  const roles = Array.from(new Set([
    settings.preferences.primaryTargetRole,
    ...settings.preferences.secondaryTargetRoles,
  ].filter(Boolean))) as string[];

  return (
    <Panel title="Job Search" description={blurb}>
      <div className="flex flex-col gap-5">
        <div className="rounded-[14px] bg-[var(--tile-lav-bg)] p-4 sm:p-5">
          <h3 className="text-[17px] font-bold text-primary">Your search uses Profile information</h3>
          <p className="mt-1 max-w-[62ch] text-[14px] leading-6 text-secondary">Target roles, locations, workplace preferences, and work authorization are professional facts. Edit them once in Profile and Career-Ops uses the saved values everywhere.</p>
          <Link href="/profile" className={`${BTN_SECONDARY} mt-4 min-h-11 text-[14px]`}>Review Profile</Link>
        </div>
        <dl className="grid gap-4 sm:grid-cols-2">
          <SummaryRow label="Target roles" value={roles.join(", ") || null} />
          <SummaryRow label="Preferred location" value={settings.preferences.locationPreference} />
          <SummaryRow label="Workplace" value={settings.preferences.workplacePreference.join(" · ") || null} />
          <SummaryRow label="Employment type" value={settings.preferences.employmentTypePreference} />
          <SummaryRow label="Work authorization" value={settings.matchAffecting.workAuthorizedUS ? "Authorized to work in the U.S." : "Not authorized to work in the U.S."} />
          <SummaryRow label="Sponsorship" value={settings.matchAffecting.requiresSponsorship ? "Required" : "Not required"} />
        </dl>
      </div>
    </Panel>
  );
}

function SummaryRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="min-w-0">
      <dt className="text-[13px] font-semibold uppercase tracking-[0.065em] text-tertiary">{label}</dt>
      <dd className="mt-1.5 text-[15px] leading-6 text-primary">
        {value ?? <span className="text-tertiary">Not provided</span>}
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
                <div className="text-[15px] font-semibold text-primary">{p.title}</div>
                <p className="mt-1 text-[14px] leading-6 text-tertiary">{p.description}</p>
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
        <p className="text-[14px] leading-6 text-tertiary">
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
 * Two truthful, read-only application facts. Final approval is rendered as a locked fact, not a
 * switch: the engine requires a person to approve every submission, and a settings page that
 * appeared able to turn that off would be describing a product that does not exist. Saved answers
 * reflect the candidate's existing store without exposing operational background-worker settings.
 */
function ApplicationsPanel({
  blurb,
  savedAnswers,
}: {
  blurb: string;
  savedAnswers: number | null;
}) {
  return (
    <Panel title="Applications" description={blurb}>
      {/* Not a toggle, and never will be one. */}
      <Field label="Final approval">
        <div className="flex items-start gap-2.5 rounded-[10px] bg-[var(--tile-green-bg)] px-4 py-3">
          <span aria-hidden="true" className="mt-px shrink-0 text-[var(--pill-success-fg)]">
            <IconShield size={17} />
          </span>
          <div className="min-w-0">
            <div className="text-[15px] font-semibold text-[var(--pill-success-fg)]">
              Always required before submission
            </div>
            <p className="mt-1 max-w-[68ch] text-[14px] leading-6 text-secondary">
              Career-Ops fills in what it can evidence and stops for anything it cannot. Nothing is
              ever submitted to an employer until you approve it, and there is no setting that
              changes that.
            </p>
          </div>
        </div>
      </Field>

      <Field
        label="Saved application answers"
        hint="Answers you give during an application are kept so Career-Ops can offer them again on a similar question."
      >
        {savedAnswers === null ? (
          <p className="text-[14px] text-tertiary">Not available.</p>
        ) : (
          /* UI-AM.1 checkpoint decision — the link is always shown, even at zero, rather than only
           *  once answers exist. Precedent already set on this same page: the Job Search panel's
           *  own "Review Profile" link is unconditional regardless of whether Profile has any data
           *  yet. Answer Memory's own destination page already renders a real, honest, non-dead-end
           *  empty state (confirmed in visual QA) — hiding the link at zero would make this the one
           *  Settings destination whose existence a candidate cannot discover until data happens to
           *  exist, contradicting the "0 is a real, showable fact" principle already used everywhere
           *  else on this page (StatTile's own doc comment: "renders the number even when it is
           *  zero"). */
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-[15px] text-primary">
              {savedAnswers === 0 ? (
                "No reusable answers saved yet."
              ) : (
                <>
                  <span className="font-semibold tabular-nums">{savedAnswers}</span>{" "}
                  {savedAnswers === 1 ? "answer" : "answers"} saved.
                </>
              )}
            </p>
            <Link href="/settings/answers" className={`${BTN_SECONDARY} min-h-11 text-[14px]`}>
              Manage saved answers
            </Link>
          </div>
        )}
      </Field>
    </Panel>
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
        <h3 className="text-[18px] font-bold text-primary">Career Copilot</h3>
        <p className="max-w-[54ch] text-[15px] leading-6 text-secondary">
          Ask why a job matches your evidence, from any job. Copilot answers from your own profile
          and resumes — it runs only when you ask it something, never on its own.
        </p>
        <p className="max-w-[58ch] text-[13px] leading-5 text-tertiary">Your Career-Ops data is stored locally on this Mac. Some AI-assisted features may send the content needed for a task to the configured AI service.</p>
        {/* No provider, model or key configuration: that is developer setup, not a candidate
         *  preference, and it would put credentials on a candidate-facing page. */}
        <Pill tone="neutral">Not configurable yet</Pill>
      </div>
    </Panel>
  );
}

/* ── Appearance ─────────────────────────────────────────────────────────────────────────────── */

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/**
 * The one theme control. A segmented radio group, not an icon-only sun/moon toggle: each option has
 * a real visible label, and the selected option changes both background AND weight — never color
 * alone. Read from storage on mount rather than assumed "system", since a returning visitor may
 * already have an explicit choice; ThemeScript has already applied it before this ever paints.
 */
function AppearancePanel({ blurb }: { blurb: string }) {
  const [preference, setPreference] = useState<ThemePreference>("system");

  useEffect(() => {
    // Intentional: reads the already-applied client preference once on mount, not a render loop.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPreference(readStoredThemePreference());
  }, []);

  return (
    <Panel title="Appearance" description={blurb}>
      <Field
        label="Theme"
        hint="System matches this device's own light/dark setting. Light or Dark overrides it for Career-Ops only."
      >
        <div
          role="radiogroup"
          aria-label="Theme"
          className="inline-flex gap-1 rounded-[10px] border border-[var(--border)] bg-[var(--z1-bg)] p-1"
        >
          {THEME_OPTIONS.map((opt) => {
            const checked = preference === opt.value;
            return (
              <label
                key={opt.value}
                className={`relative flex min-h-11 min-w-[84px] cursor-pointer items-center justify-center rounded-[8px] px-4 text-[14px] transition-colors duration-150 ease-out has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--focus-ring)] ${
                  checked
                    ? "bg-[var(--accent)] font-semibold text-[var(--accent-fg)]"
                    : "font-medium text-secondary hover:text-primary"
                }`}
              >
                <input
                  type="radio"
                  name="theme-preference"
                  value={opt.value}
                  checked={checked}
                  onChange={() => {
                    setPreference(opt.value);
                    setThemePreference(opt.value);
                  }}
                  className="sr-only"
                />
                {opt.label}
              </label>
            );
          })}
        </div>
      </Field>
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
 * This batch adds no destructive actions and does not advertise unavailable ones.
 */
function DataPrivacyPanel({ blurb, candidate }: { blurb: string; candidate: CandidateRecord }) {
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

        <Field
          label="What Career-Ops stores"
          hint="Your Career-Ops data is stored locally on this Mac. Some AI-assisted features may send the content needed for a task to the configured AI service."
        >
          <ul className="flex flex-col gap-1.5">
            {[
              "Your master resume and skills inventory",
              "Jobs scanned, and how each one matched your evidence",
              "Tailored resumes and their validation history",
              "Answers you give during an application",
            ].map((t) => (
              <li key={t} className="flex items-start gap-2.5 text-[14px] leading-6 text-secondary">
                <span aria-hidden="true" className="mt-[7px] h-1.5 w-1.5 shrink-0 rotate-45 bg-[var(--accent)]" />
                {t}
              </li>
            ))}
          </ul>
        </Field>
      </Panel>
    </>
  );
}
