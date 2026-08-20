"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The optional PIN step, offered once — after a profile exists and is worth protecting.
 *
 * WHY IT IS HERE AND NOT EARLIER. Setting a PIN used to be something you found in Settings, which
 * meant most profiles never got one. Moving it into first-run made it the second thing a new user
 * met, before they had anything to protect: a PIN on an empty profile locks you out of nothing,
 * and forgetting it at that point is pure cost. Offering it the moment a real profile lands — with
 * a genuine skip — puts the choice where the value is obvious and the stakes are understood.
 *
 * SKIPPING IS A REAL CHOICE, NOT A DELAY. Choosing "Not now" continues straight on; the prompt
 * does not reappear later in the flow. Security stays available in Settings, and every existing
 * protection is unchanged: profiles that already have a PIN still require it, unlocking still
 * expires, and this screen cannot remove or replace a PIN that is already set.
 */

export function ProtectProfilePrompt({
  candidateId,
  onDone,
}: {
  candidateId: number;
  /** Called for both outcomes — set and skipped — so the caller continues either way. */
  onDone: () => void;
}) {
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Focus lands on the first field so the step is immediately usable from the keyboard.
    firstFieldRef.current?.focus();
  }, []);

  const digitsOnly = (v: string) => v.replace(/\D/g, "").slice(0, 4);
  const ready = pin.length === 4 && confirmPin.length === 4;

  async function submit() {
    setError(null);
    if (pin !== confirmPin) {
      setError("The two PINs do not match.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/candidates/${candidateId}/pin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "The PIN could not be set.");
        return;
      }
      onDone();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="plane plane-3 rounded-[var(--radius-xl)] px-5 py-4">
      <h2 className="text-[14px] font-semibold tracking-[-0.01em] text-primary">Protect this profile</h2>
      <p className="mt-1.5 max-w-[52ch] text-[12.5px] leading-relaxed text-tertiary">
        A four-digit PIN keeps your resume, evidence and job history private from anyone else using
        this app. You can add or change it later in Settings.
      </p>

      <div className="mt-3.5 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-[12px] font-medium text-secondary">PIN</span>
          <input
            ref={firstFieldRef}
            /* Numeric keypad on phones without becoming a spinner on desktop, and never stored by
             * a password manager as an account password. */
            inputMode="numeric"
            autoComplete="off"
            type="password"
            value={pin}
            onChange={(e) => setPin(digitsOnly(e.target.value))}
            placeholder="••••"
            aria-describedby="pin-help"
            className="w-24 rounded-md border border-[var(--border)] bg-surface px-2.5 py-1.5 text-center text-[16px] tracking-[0.3em] text-primary outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[12px] font-medium text-secondary">Confirm</span>
          <input
            inputMode="numeric"
            autoComplete="off"
            type="password"
            value={confirmPin}
            onChange={(e) => setConfirmPin(digitsOnly(e.target.value))}
            placeholder="••••"
            className="w-24 rounded-md border border-[var(--border)] bg-surface px-2.5 py-1.5 text-center text-[16px] tracking-[0.3em] text-primary outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
          />
        </label>

        <button
          type="button"
          onClick={submit}
          disabled={!ready || saving}
          className="rounded-md bg-[var(--accent)] px-3.5 py-2 text-[13px] font-semibold text-[var(--accent-fg)] transition-[background-color,transform] duration-150 ease-out hover:bg-[var(--accent-hover)] active:scale-[0.98] disabled:opacity-50"
        >
          {saving ? "Setting…" : "Set PIN"}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="rounded-md px-3 py-2 text-[13px] font-medium text-secondary underline-offset-2 transition-colors duration-150 ease-out hover:text-primary hover:underline"
        >
          Not now
        </button>
      </div>

      <p id="pin-help" className="mt-2 text-[11px] leading-relaxed text-tertiary">
        {!ready && !error
          ? "Enter the same four digits twice to continue, or choose Not now."
          : "Four digits. Stored hashed — it is never shown again, so pick one you will remember."}
      </p>

      {error && (
        <p role="alert" className="mt-2 text-[12px] text-[var(--error)]">
          {error}
        </p>
      )}
    </div>
  );
}
