/**
 * ADMIN-OPS-5 — strips filesystem paths from operator-facing text.
 *
 * SQLite reports failures like "unable to open database file: /Users/<name>/Documents/…/app.db".
 * The failure is the half an operator needs; the location is the half that identifies them. On a
 * local-first product the path contains the account name, so anything reachable without a session
 * must not carry it.
 *
 * Extracted from the health route so it can be tested against real strings rather than asserted on
 * by reading source, and reused wherever a raw message reaches Admin.
 */
export function redactPaths(message: string | null): string | null {
  if (message === null) return null;
  return message
    /* A database file, wherever it lives, keeps its recognisable name. */
    .replace(/(?:\/[^\s'"]*)?\/([^/\s'"]+\.db(?:-wal|-shm)?)/g, "<data-dir>/$1")
    /* Any other absolute path on the common roots, including Windows drive letters. */
    .replace(/\/(?:Users|home|var|tmp|private|opt|srv)\/[^\s'"]*/g, "<path>")
    .replace(/[A-Za-z]:\\[^\s'"]*/g, "<path>");
}
