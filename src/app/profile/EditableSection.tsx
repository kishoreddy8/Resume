"use client";

import { useState, type ReactNode } from "react";
import { BTN_PRIMARY, BTN_QUIET, Panel } from "@/components/ui";

/**
 * A panel that can be read or edited, one section at a time.
 *
 * SECTION-LEVEL, NOT PAGE-LEVEL. A single form over identity, preferences and work authorization
 * would be roughly forty fields, and it would put "Save" at the bottom of a page whose top field
 * changes what jobs you are shown. Each section owns its own draft, its own Save and its own error,
 * so editing your target roles cannot fail because an unrelated field elsewhere is invalid.
 *
 * NOTHING IS SAVED OPTIMISTICALLY. `onSave` must resolve before the panel leaves edit mode, and the
 * confirmation appears only after the server has answered. Work authorization in particular is a
 * match-affecting fact — showing it as saved before it is would be showing you a filter that is not
 * actually applied.
 *
 * The read view stays mounted in the DOM until Save resolves, so a failed save leaves your typing
 * exactly where it was rather than discarding it behind a toast.
 */
export function EditableSection<T>({
  title,
  description,
  value,
  onSave,
  canEdit = true,
  view,
  form,
  editLabel = "Edit",
  compact = false,
  defaultOpen = false,
  icon,
}: {
  title: string;
  description?: ReactNode;
  /** The persisted value. Re-read after every successful save. */
  value: T;
  /** Resolves on success, rejects with a message the panel shows verbatim. */
  onSave: (draft: T) => Promise<void>;
  canEdit?: boolean;
  view: (value: T) => ReactNode;
  form: (draft: T, set: (next: T) => void) => ReactNode;
  editLabel?: string;
  /** Denser padding for the four-across quick-section row. */
  compact?: boolean;
  /** Start in edit mode. The caller remounts with a new key to re-trigger it, so this needs no
   *  effect: a remount rebuilds the draft from `value`, which is exactly the intended reset. */
  defaultOpen?: boolean;
  icon?: ReactNode;
}) {
  const [editing, setEditing] = useState(defaultOpen);
  const [draft, setDraft] = useState<T>(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  function open() {
    setDraft(value);
    setError(null);
    setSavedAt(null);
    setEditing(true);
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await onSave(draft);
      setEditing(false);
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : "We couldn't save this. Nothing was changed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Panel
      title={title}
      description={description}
      compact={compact}
      icon={icon}
      actions={
        canEdit && !editing ? (
          <button type="button" onClick={open} className={BTN_QUIET}>
            {editLabel}
          </button>
        ) : null
      }
    >
      {editing ? (
        <div className="flex flex-col gap-4">
          {form(draft, setDraft)}
          {error && (
            <p role="alert" className="text-[12.5px] leading-relaxed text-[var(--error)]">
              {error}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={save} disabled={saving} className={BTN_PRIMARY}>
              {saving ? "Saving…" : "Save changes"}
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setError(null);
              }}
              disabled={saving}
              className={BTN_QUIET}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          {view(value)}
          {/* Announced, not just coloured — the change it confirms happened somewhere above it. */}
          {savedAt !== null && (
            <p aria-live="polite" className="mt-3 text-[12px] font-medium text-[var(--pill-success-fg)]">
              Saved.
            </p>
          )}
        </>
      )}
    </Panel>
  );
}
