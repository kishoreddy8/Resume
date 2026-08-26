"use client";

/**
 * UI-2 — the last-resort boundary: the root layout itself failed to render, so nothing this app
 * normally depends on (globals.css tokens, AppShell, the ui/ primitives) can be assumed safe to use
 * here. Next.js requires this file to render its own <html>/<body> for exactly this reason.
 * Deliberately plain, inline-styled, and dependency-free — the one place in the app where that is
 * the correct choice rather than a regression.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "system-ui, -apple-system, sans-serif", background: "#fff", color: "#14161d" }}>
        <div style={{ maxWidth: "52ch", margin: "10vh auto 0", padding: "0 24px" }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 8 }}>Career-Ops couldn&apos;t load</h1>
          <p style={{ fontSize: 14, lineHeight: 1.6, color: "#4e5566", marginBottom: 16 }}>
            Something failed before the page itself could start. Nothing you were doing caused this, and no action was
            submitted.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              height: 42,
              padding: "0 16px",
              borderRadius: 10,
              border: "none",
              background: "#4B3FE4",
              color: "#fff",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
          {error.digest && <p style={{ fontSize: 12, color: "#787f92", marginTop: 20 }}>Ref: {error.digest}</p>}
        </div>
      </body>
    </html>
  );
}
