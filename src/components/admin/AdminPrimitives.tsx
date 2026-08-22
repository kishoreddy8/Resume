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
  actions,
}: {
  title: string;
  description: string;
  eyebrow?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="admin-page-header">
      <div className="min-w-0">
        {eyebrow && <p className="admin-eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        <p className="admin-page-description">{description}</p>
      </div>
      {actions && <div className="admin-page-actions">{actions}</div>}
    </header>
  );
}

export function AdminStatus({ status, label }: { status: AdminStatusKey | string; label?: string }) {
  const normalized = normalizeAdminStatus(status);
  const presentation = ADMIN_STATUS_PRESENTATION[normalized];
  return (
    <span className={`admin-status admin-status-${presentation.tone}`} data-status={normalized}>
      <span className="admin-status-symbol" aria-hidden="true">
        {presentation.symbol}
      </span>
      {label ?? presentation.label}
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
    <Link href={href} className="admin-health-link">
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
  if (items.length === 0) return <AdminEmptyState title="No intervention needed" detail="There is no operator action waiting in this view." />;
  return (
    <ul className="admin-intervention-list">
      {items.map((item) => (
        <li key={item.id}>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3>{item.title}</h3>
              <AdminStatus status={item.status} />
            </div>
            <p>{item.detail}</p>
            {item.meta && <span className="admin-meta">{item.meta}</span>}
          </div>
          {item.href && (
            <Link className="admin-inline-action" href={item.href}>
              Review
            </Link>
          )}
        </li>
      ))}
    </ul>
  );
}

export function OperationalTable({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="admin-table-scroll" role="region" aria-label={label} tabIndex={0}>
      <table className="admin-table">{children}</table>
    </div>
  );
}

export function OperationalCardList({ children }: { children: ReactNode }) {
  return <div className="admin-operational-cards">{children}</div>;
}

export function TechnicalDetails({ summary = "Technical details", children }: { summary?: string; children: ReactNode }) {
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

export function AdminEmptyState({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return (
    <div className="admin-state admin-state-empty">
      <span aria-hidden="true">○</span>
      <h2>{title}</h2>
      <p>{detail}</p>
      {action}
    </div>
  );
}

export function AdminErrorState({ title = "Unable to load", detail, retry }: { title?: string; detail: string; retry?: () => void }) {
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
      {label}
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
          <button type="button" className="admin-button admin-button-secondary" disabled={busy} onClick={close}>
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
