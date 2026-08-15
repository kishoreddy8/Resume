#!/usr/bin/env node
"use strict";

// PreToolUse hook: blocks broad `git add .` / `git add -A` / `git add --all`
// staging commands. Explicit file-by-file `git add` calls are always allowed.

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

function isBroadGitAdd(argsStr) {
  const tokens = argsStr.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;

  if (tokens.some((t) => t === "-A" || t === "--all")) return true;

  const nonFlagTokens = tokens.filter((t) => !t.startsWith("-"));
  if (nonFlagTokens.length > 0 && nonFlagTokens.every((t) => t === "." || t === "./")) {
    return true;
  }

  return false;
}

// Split on shell separators so matching only ever looks at whole command
// invocations, never at "git add ..." appearing inside an unrelated segment
// (e.g. inside a quoted echo/commit-message string on the same command line).
function splitSegments(command) {
  return command
    .split(/&&|\|\||[;\n|]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const GIT_ADD_START_RE = /^git\s+add\b(.*)$/i;

async function main() {
  const raw = await readStdin();
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
    return;
  }

  if (input.tool_name !== "Bash") {
    process.exit(0);
    return;
  }

  const command = input.tool_input && input.tool_input.command;
  if (!command) {
    process.exit(0);
    return;
  }

  for (const segment of splitSegments(command)) {
    const match = GIT_ADD_START_RE.exec(segment);
    if (match && isBroadGitAdd(match[1])) {
      block(
        `Blocked by guard-git-add: "git add ${match[1].trim()}" stages the whole working tree, ` +
          `which risks pulling in scratch/backup files alongside real changes. Stage specific ` +
          `files instead, e.g. "git add path/to/file.ts".\n` +
          `Command: ${command}`
      );
    }
  }

  process.exit(0);
}

main();
