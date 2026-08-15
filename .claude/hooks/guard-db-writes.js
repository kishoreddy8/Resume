#!/usr/bin/env node
"use strict";

// PreToolUse hook: blocks accidental writes/deletes of the production SQLite
// database (data/app.db) and its -wal/-shm/-journal/.backup*/.bak* siblings.
// Reads are never blocked. CAREER_OPS_DB_PATH overrides (used by tests) are
// always allowed through.

const path = require("path");

const PROTECTED_PREFIX = "data/app.db";

function readStdin() {
  return new Promise((resolve) => {
    let raw = "";
    process.stdin.on("data", (chunk) => {
      raw += chunk;
    });
    process.stdin.on("end", () => resolve(raw));
    process.stdin.resume();
  });
}

function block(reason) {
  console.error(reason);
  process.exit(2);
}

// Split on shell separators so matching only ever looks at whole command
// invocations, never at protected-path/destructive-verb text that merely
// appears inside an unrelated segment (e.g. inside a quoted echo string).
function splitSegments(command) {
  return command
    .split(/&&|\|\||[;\n|]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// First real command word of a segment, skipping leading VAR=value env
// assignments (e.g. "CAREER_OPS_DB_PATH=/tmp/x.db rm foo" -> "rm").
function firstCommandWord(segment) {
  const tokens = segment.split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  return tokens[i] || "";
}

function isRecursiveDataDirDelete(segment) {
  // Catches `rm -rf data`, `rm -fr ./data/`, `rm -r data`, etc. — a recursive
  // delete of the whole data/ directory would take app.db with it.
  const tokens = segment.split(/\s+/).filter(Boolean);
  const cmd = firstCommandWord(segment);
  if (!/^rm$/i.test(cmd)) return false;

  const hasRecursiveFlag = tokens.some((t) => /^-[a-zA-Z]*r[a-zA-Z]*$/i.test(t));
  if (!hasRecursiveFlag) return false;

  for (const tok of tokens) {
    const stripped = tok.replace(/^["']|["']$/g, "").replace(/\/+$/, "");
    if (stripped === "data" || stripped === "./data" || stripped.endsWith("/data")) {
      return true;
    }
  }
  return false;
}

async function main() {
  const raw = await readStdin();
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
    return;
  }

  const toolName = input.tool_name;
  const toolInput = input.tool_input || {};
  const cwd = input.cwd || process.cwd();

  if (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit") {
    const filePath = toolInput.file_path || "";
    if (!filePath) {
      process.exit(0);
      return;
    }
    const resolved = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
    const rel = path.relative(cwd, resolved).split(path.sep).join("/");
    if (rel.startsWith(PROTECTED_PREFIX)) {
      block(
        `Blocked by guard-db-writes: ${toolName} targets "${rel}", the production database ` +
          `(or a related -wal/-shm/-journal/.backup/.bak file). This path is protected. If this ` +
          `is test fixture work, use a path outside data/ or the CAREER_OPS_DB_PATH override instead.`
      );
    }
    process.exit(0);
    return;
  }

  if (toolName === "Bash") {
    const command = toolInput.command || "";
    const segments = splitSegments(command);

    for (const segment of segments) {
      if (isRecursiveDataDirDelete(segment)) {
        block(
          `Blocked by guard-db-writes: this command recursively deletes the "data/" directory, ` +
            `which contains the production database (data/app.db). Target a specific subpath instead.\n` +
            `Command: ${command}`
        );
      }

      if (!segment.includes(PROTECTED_PREFIX)) continue;
      if (/CAREER_OPS_DB_PATH\s*=/.test(segment)) continue;

      const cmd = firstCommandWord(segment);
      const destructive = /^(rm|mv|cp|truncate|dd|shred|unlink)$/i.test(cmd);
      const redirectsIntoDb = /(>{1,2})\s*"?'?[^\s"']*data\/app\.db/i.test(segment);
      const isSqlite3 = /(^|\/)sqlite3$/i.test(cmd);
      const sqlWrite =
        isSqlite3 && /\b(DROP|DELETE|UPDATE|INSERT|ALTER|VACUUM|REPLACE)\b/i.test(segment);

      if (destructive || redirectsIntoDb || sqlWrite) {
        block(
          `Blocked by guard-db-writes: this Bash command appears to write to, move, or delete the ` +
            `production database (data/app.db or a related -wal/-shm/-journal/.backup/.bak file).\n` +
            `Command: ${command}\n` +
            `If this is intentional, use CAREER_OPS_DB_PATH to target a test/temp database instead.`
        );
      }
    }
  }

  process.exit(0);
}

main();
