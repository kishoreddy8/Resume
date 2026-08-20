import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import {
  hashPin,
  isValidPinFormat,
  signUnlockToken,
  verifyPin,
  verifyUnlockToken,
} from "@/lib/auth/candidatePin";

const SECRET = "a".repeat(64);

test("PIN format accepts exactly four digits and nothing else", () => {
  for (const good of ["0000", "1234", "9999"]) assert.equal(isValidPinFormat(good), true, good);
  for (const bad of ["", "123", "12345", "12a4", " 1234", "1234 ", "١٢٣٤"]) {
    assert.equal(isValidPinFormat(bad), false, JSON.stringify(bad));
  }
});

test("a hashed PIN verifies, a wrong one does not, and the hash is salted", () => {
  const a = hashPin("1234");
  const b = hashPin("1234");
  assert.notEqual(a.hash, b.hash, "same PIN must not produce the same hash — salt is missing");
  assert.equal(verifyPin("1234", a.hash, a.salt), true);
  assert.equal(verifyPin("1235", a.hash, a.salt), false);
  assert.equal(verifyPin("1234", a.hash, b.salt), false, "hash must be bound to its own salt");
});

test("verifyPin refuses malformed stored values instead of throwing", () => {
  assert.equal(verifyPin("1234", "", ""), false);
  assert.equal(verifyPin("1234", "nothex", "salt"), false);
});

test("a valid unlock token round-trips", () => {
  const exp = Date.now() + 60_000;
  const payload = verifyUnlockToken(signUnlockToken({ ids: [1, 3], exp }, SECRET), SECRET);
  assert.deepEqual(payload, { ids: [1, 3], exp });
});

test("a tampered payload is rejected — a browser cannot add a candidate id", () => {
  const token = signUnlockToken({ ids: [1], exp: Date.now() + 60_000 }, SECRET);
  const [body, mac] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ ids: [1, 2, 3], exp: Date.now() + 60_000 }), "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  assert.equal(verifyUnlockToken(`${forged}.${mac}`, SECRET), null);
  assert.equal(verifyUnlockToken(`${body}.${mac}x`, SECRET), null);
  assert.equal(verifyUnlockToken(token, "b".repeat(64)), null, "a different secret must not verify");
});

test("an expired token is rejected", () => {
  const token = signUnlockToken({ ids: [1], exp: Date.now() - 1 }, SECRET);
  assert.equal(verifyUnlockToken(token, SECRET), null);
});

test("garbage tokens are rejected rather than throwing", () => {
  for (const t of [undefined, "", ".", "a.b", "no-dot", "..", "x".repeat(500)]) {
    assert.equal(verifyUnlockToken(t as string | undefined, SECRET), null, JSON.stringify(t));
  }
});

/**
 * Completeness, enforced here rather than by memory.
 *
 * The access check is a helper called per route, not middleware — middleware runs on the edge and
 * cannot reach better-sqlite3 to ask whether a profile is even protected. The trade-off is that a
 * new route could forget the guard, so this walks every route file, finds the ones that read a
 * candidateId, and fails if one does not call requireCandidateAccess. The unlock and pin routes are
 * exempt because they ARE the authorisation surface.
 */
test("every candidate-scoped API route calls requireCandidateAccess", () => {
  const root = path.join(process.cwd(), "src", "app", "api");
  const missing: string[] = [];
  let guarded = 0;

  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
        continue;
      }
      if (entry.name !== "route.ts") continue;
      const src = fs.readFileSync(p, "utf-8");
      if (!src.includes("candidateId")) continue;
      const rel = p.slice(root.length);
      if (rel.includes(`${path.sep}unlock${path.sep}`) || rel.includes(`${path.sep}pin${path.sep}`)) continue;
      if (src.includes("requireCandidateAccess")) guarded += 1;
      else missing.push(rel);
    }
  };
  walk(root);

  assert.deepEqual(missing, [], `candidate-scoped routes missing the access guard: ${missing.join(", ")}`);
  assert.ok(guarded >= 24, `expected at least 24 guarded routes, found ${guarded}`);
});
