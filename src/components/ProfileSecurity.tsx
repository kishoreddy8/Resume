"use client";

import { useCallback, useEffect, useState } from "react";
import { Surface } from "@/components/ui";

/**
 * Profile PIN management, and owner-authorised deletion of other profiles.
 *
 * The honesty requirement here is the "no PIN set" state. A profile without a PIN is genuinely open
 * to anyone who can reach this app, so the UI says exactly that rather than showing a neutral
 * "Security" heading that implies protection nobody has.
 */

interface Candidate {
  id: number;
  display_name: string;
}
interface PinStatus {
  candidateId: number;
  hasPin: boolean;
  isOwner: boolean;
  unlocked: boolean;
  lockedUntil: string | null;
}

export function ProfileSecurity({ candidateId }: { candidateId: number }) {
  const [status, setStatus] = useState<PinStatus | null>(null);
  const [pin, setPin] = useState("");
  const [currentPin, setCurrentPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [others, setOthers] = useState<Candidate[]>([]);

  const load = useCallback(async () => {
    const [s, c] = await Promise.all([
      fetch(`/api/candidates/${candidateId}/unlock`).then((r) => (r.ok ? r.json() : null)),
      fetch("/api/candidates").then((r) => (r.ok ? r.json() : { candidates: [] })),
    ]);
    setStatus(s);
    setOthers((c.candidates ?? []).filter((x: Candidate) => x.id !== candidateId));
  }, [candidateId]);

  useEffect(() => {
    // Intentional: fetch-on-mount/candidate-change with a loading flag, the pattern used across
    // this app. `load` is memoised on candidateId, so this is not a render loop.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  async function savePin() {
    if (!/^\d{4}$/.test(pin)) return setMsg({ kind: "err", text: "PIN must be exactly 4 digits." });
    setBusy(true);
    try {
      const res = await fetch(`/api/candidates/${candidateId}/pin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin, currentPin: currentPin || undefined }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Could not set the PIN.");
      setMsg({ kind: "ok", text: "PIN saved. This profile now requires it." });
      setPin("");
      setCurrentPin("");
      await load();
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : "Could not set the PIN." });
    } finally {
      setBusy(false);
    }
  }

  async function removePin() {
    setBusy(true);
    try {
      const res = await fetch(`/api/candidates/${candidateId}/pin`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPin: currentPin || undefined }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Could not remove the PIN.");
      setMsg({ kind: "ok", text: "PIN removed. This profile is open again." });
      setCurrentPin("");
      await load();
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : "Could not remove the PIN." });
    } finally {
      setBusy(false);
    }
  }

  async function deleteProfile(target: Candidate) {
    // Irreversible: say what goes, and name the profile so it cannot be confused with another.
    const confirmed = window.confirm(
      `Permanently delete “${target.display_name}”?\n\nThis removes their match results, notifications, resume workflows and uploaded Master Resume/Skills files. It cannot be undone.`
    );
    if (!confirmed) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/candidates/${target.id}`, { method: "DELETE" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Could not delete that profile.");
      const rows = Object.values(body.deletedRows ?? {}).reduce((a: number, b) => a + Number(b), 0);
      setMsg({ kind: "ok", text: `Deleted “${target.display_name}” — ${rows} rows removed.` });
      // Reload so the app-shell candidate selector drops the deleted profile too — see page.tsx.
      window.location.reload();
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : "Could not delete that profile." });
    } finally {
      setBusy(false);
    }
  }

  const input =
    "w-28 rounded-md border border-[var(--border)] bg-surface px-2 py-1.5 text-[13px] tabular-nums tracking-[0.3em] text-primary outline-none focus:ring-2 focus:ring-[var(--focus-ring)]";
  const btn =
    "rounded-md border border-[var(--border)] px-2.5 py-1.5 text-[12px] font-medium text-secondary transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] hover:text-primary active:scale-[0.98] disabled:opacity-50";

  return (
    <Surface level="z3" as="section" className="rounded-[var(--radius-xl)] px-5 py-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[9.5px] font-semibold uppercase tracking-[0.11em] text-tertiary">Profile access</h2>
        {status?.isOwner && (
          <span className="text-[10px] uppercase tracking-[0.07em] text-[var(--accent)]">Owner</span>
        )}
      </div>

      {status && !status.hasPin && (
        <p className="mt-2 text-[12px] leading-relaxed text-[var(--warning)]">
          No PIN set — this profile is open to anyone who can reach this app on your network.
        </p>
      )}
      {status?.hasPin && (
        <p className="mt-2 text-[12px] leading-relaxed text-secondary">
          Protected by a 4-digit PIN. An unlock lasts 30 minutes, then it asks again.
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-end gap-2">
        {status?.hasPin && (
          <label className="text-[11px] text-tertiary">
            <span className="mb-1 block">Current PIN</span>
            <input
              value={currentPin}
              onChange={(e) => setCurrentPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
              inputMode="numeric"
              autoComplete="off"
              className={input}
            />
          </label>
        )}
        <label className="text-[11px] text-tertiary">
          <span className="mb-1 block">{status?.hasPin ? "New PIN" : "Set a PIN"}</span>
          <input
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
            inputMode="numeric"
            autoComplete="off"
            className={input}
          />
        </label>
        <button type="button" onClick={savePin} disabled={busy} className={btn}>
          {status?.hasPin ? "Change PIN" : "Set PIN"}
        </button>
        {status?.hasPin && (
          <button type="button" onClick={removePin} disabled={busy} className={btn}>
            Remove PIN
          </button>
        )}
      </div>

      {msg && (
        <p className={`mt-2 text-[12px] ${msg.kind === "ok" ? "text-[var(--success)]" : "text-[var(--error)]"}`}>
          {msg.text}
        </p>
      )}

      {status?.isOwner && others.length > 0 && (
        <div className="mt-5 border-t border-[var(--separator)] pt-3">
          <h3 className="text-[9.5px] font-semibold uppercase tracking-[0.11em] text-tertiary">
            Manage profiles
          </h3>
          <p className="mt-1 text-[11.5px] leading-relaxed text-tertiary">
            Only the owner can delete a profile, and only while the owner profile is unlocked. The
            owner account itself cannot be deleted.
          </p>
          <ul className="mt-2">
            {others.map((c) => (
              <li key={c.id} className="flex items-center gap-3 border-b border-[var(--separator)] py-2 last:border-b-0">
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-primary">{c.display_name}</span>
                <span className="shrink-0 text-[11px] tabular-nums text-tertiary">#{c.id}</span>
                <button
                  type="button"
                  onClick={() => deleteProfile(c)}
                  disabled={busy}
                  className="shrink-0 rounded-md border border-[var(--error)]/35 px-2 py-1 text-[11px] font-medium text-[var(--error)] transition-colors duration-150 ease-out hover:bg-[color-mix(in_oklab,var(--error)_10%,transparent)] active:scale-[0.98] disabled:opacity-50"
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Surface>
  );
}
