"use client";

import Link from "next/link";
import { useEffect, useId, useRef, type ReactNode } from "react";
import {
  ADMIN_STATUS_PRESENTATION,
  normalizeAdminStatus,
  type AdminStatusKey,
} from "@/lib/admin/status";

export function AdminPageHeader({
  title,
  description,
  eyebrow,
  statusSummary,
  actions,
}: {
  title: string;
  description: string;
  eyebrow?: string;
  statusSummary?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="admin-page-header">
      <div className="min-w-0 max-w-3xl">
        {eyebrow && <p className="admin-eyebrow">{eyebrow}</p>}
        <div className="flex flex-wrap items-center gap-3">
          <h1>{title}</h1>
          {statusSummary && <div className="inline-flex items-center">{statusSummary}</div>}
        </div>
        <p className="admin-page-description">{description}</p>
      </div>
      {actions && <div className="admin-page-actions">{actions}</div>}
    </header>
  );
}

export function AdminStatus({
  status,
  label,
  size = "normal",
}: {
  status: AdminStatusKey | string;
  label?: string;
  size?: "normal" | "compact";
}) {
  const normalized = normalizeAdminStatus(status);
  const presentation = ADMIN_STATUS_PRESENTATION[normalized];
  return (
    <span
      className={`admin-status admin-status-${presentation.tone} ${
        size === "compact" ? "admin-status-compact" : ""
      }`}
      data-status={normalized}
      role="status"
    >
      <span className="admin-status-symbol" aria-hidden="true">
        {presentation.symbol}
      </span>
      <span>{label ?? presentation.label}</span>
    </span>
  );
}

export function HealthTile({
  label,
  status,
  value,
  detail,
  href,
}: {
  label: string;
  status: AdminStatusKey | string;
  value?: string | number;
  detail?: string;
  href?: string;
}) {
  const body = (
    <div className="admin-health-tile">
      <div className="flex items-center justify-between gap-3">
        <h2>{label}</h2>
        <AdminStatus status={status} />
      </div>
      {value !== undefined && <p className="admin-health-value">{value}</p>}
      {detail && <p className="admin-health-detail">{detail}</p>}
    </div>
  );
  return href ? (
    <Link href={href} className="admin-health-link" aria-label={`${label} details`}>
      {body}
    </Link>
  ) : (
    body
  );
}

export interface InterventionItem {
  id: string | number;
  title: string;
  detail: string;
  status: AdminStatusKey;
  href?: string;
  meta?: string;
}

export function InterventionList({ items }: { items: InterventionItem[] }) {
  if (items.length === 0) {
    return (
      <AdminEmptyState
        title="No intervention needed"
        detail="There are no operator actions waiting in this view."
      />
    );
  }
  return (
    <ul className="admin-intervention-list">
      {items.map((item) => (
        <li key={item.id}>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <h3>{item.title}</h3>
              <AdminStatus status={item.status} size="compact" />
            </div>
            <p>{item.detail}</p>
            {item.meta && <span className="admin-meta">{item.meta}</span>}
          </div>
          {item.href && (
            <Link className="admin-button admin-button-secondary shrink-0" href={item.href}>
              Review
            </Link>
          )}
        </li>
      ))}
    </ul>
  );
}

export function OperationalTable({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="admin-table-scroll" role="region" aria-label={label} tabIndex={0}>
      <table className="admin-table">{children}</table>
    </div>
  );
}

export function OperationalCardList({ children }: { children: ReactNode }) {
  return <div className="admin-operational-cards">{children}</div>;
}

export function TechnicalDetails({
  summary = "Technical details",
  children,
}: {
  summary?: string;
  children: ReactNode;
}) {
  return (
    <details className="admin-technical-details">
      <summary>{summary}</summary>
      <div>{children}</div>
    </details>
  );
}

export function TimeWindowControl<T extends string>({
  value,
  options,
  onChange,
  label = "Time window",
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  label?: string;
}) {
  return (
    <fieldset className="admin-segmented-control">
      <legend className="sr-only">{label}</legend>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </fieldset>
  );
}

export function AdminGuidanceCard({
  title,
  purpose,
  currentState,
  whyDisabled,
  nextSteps,
  action,
  tone = "info",
}: {
  title: string;
  purpose: string;
  currentState?: string;
  whyDisabled?: string;
  nextSteps?: string;
  action?: ReactNode;
  tone?: "info" | "warning" | "neutral";
}) {
  const toneClasses = {
    info: "border-[var(--accent-tint)] bg-[var(--accent-tint-weak)] text-primary",
    warning: "border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-200",
    neutral: "border-[var(--border)] bg-[var(--z2-bg)] text-primary",
  };

  return (
    <div className={`rounded-2xl border p-5 md:p-6 ${toneClasses[tone]}`}>
      <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
        <div className="space-y-2 max-w-3xl">
          <h3 className="text-[17px] font-bold text-primary flex items-center gap-2">
            <span aria-hidden="true" className="text-[var(--accent)] font-extrabold">ℹ</span>
            {title}
          </h3>
          <p className="text-[14.5px] leading-relaxed text-secondary">{purpose}</p>
          {currentState && (
            <p className="text-[14px] text-tertiary">
              <strong className="text-secondary">Current state:</strong> {currentState}
            </p>
          )}
          {whyDisabled && (
            <p className="text-[14px] text-amber-800 dark:text-amber-300 font-medium">
              <strong>Requirement:</strong> {whyDisabled}
            </p>
          )}
          {nextSteps && (
            <p className="text-[14px] text-secondary">
              <strong>Next step:</strong> {nextSteps}
            </p>
          )}
        </div>
        {action && <div className="shrink-0 pt-1">{action}</div>}
      </div>
    </div>
  );
}

export function AdminFeedbackBanner({
  tone = "success",
  message,
  onDismiss,
}: {
  tone?: "success" | "error" | "info" | "warning";
  message: string;
  onDismiss?: () => void;
}) {
  const toneClasses = {
    success: "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
    error: "border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300",
    warning: "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
    info: "border-blue-300 bg-blue-50 text-blue-900 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300",
  };

  return (
    <div className={`flex items-center justify-between gap-3 rounded-xl border p-4 text-[14.5px] font-medium ${toneClasses[tone]}`} role="alert">
      <div className="flex items-center gap-2.5">
        <span aria-hidden="true" className="font-bold">
          {tone === "success" ? "✓" : tone === "error" ? "×" : "!"}
        </span>
        <span>{message}</span>
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="text-xs font-semibold underline opacity-80 hover:opacity-100"
          aria-label="Dismiss feedback"
        >
          Dismiss
        </button>
      )}
    </div>
  );
}

export function AdminEmptyState({
  title,
  detail,
  action,
}: {
  title: string;
  detail: string;
  action?: ReactNode;
}) {
  return (
    <div className="admin-state admin-state-empty">
      <span aria-hidden="true">○</span>
      <h2>{title}</h2>
      <p>{detail}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function AdminErrorState({
  title = "Unable to load",
  detail,
  retry,
}: {
  title?: string;
  detail: string;
  retry?: () => void;
}) {
  return (
    <div className="admin-state admin-state-error" role="alert">
      <span aria-hidden="true">!</span>
      <h2>{title}</h2>
      <p>{detail}</p>
      {retry && (
        <button type="button" className="admin-button admin-button-secondary" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function AdminLoadingState({ label = "Loading operational data" }: { label?: string }) {
  return (
    <div className="admin-loading" role="status" aria-live="polite">
      <span className="admin-loading-mark" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function AdminConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  destructive = false,
  busy = false,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const previousFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      previousFocus.current = document.activeElement as HTMLElement | null;
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  function close() {
    onClose();
    queueMicrotask(() => previousFocus.current?.focus());
  }

  return (
    <dialog
      ref={dialogRef}
      className="admin-dialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close();
      }}
      onClose={() => {
        if (open) onClose();
      }}
    >
      <form method="dialog" onSubmit={(event) => event.preventDefault()}>
        <h2 id={titleId}>{title}</h2>
        <p id={descriptionId}>{description}</p>
        <div className="admin-dialog-actions">
          <button
            type="button"
            className="admin-button admin-button-secondary"
            disabled={busy}
            onClick={close}
          >
            Cancel
          </button>
          <button
            type="button"
            className={`admin-button ${destructive ? "admin-button-danger" : "admin-button-primary"}`}
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </form>
    </dialog>
  );
}
