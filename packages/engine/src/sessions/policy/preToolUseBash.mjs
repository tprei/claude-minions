#!/usr/bin/env node
// Best-effort PreToolUse policy hook for the Claude Code Bash tool.
//
// This is defense-in-depth, NOT a security boundary. The authoritative guard
// is the sandbox `allowOnly` set in writeSessionSettings — that one runs in
// the kernel. This hook just catches obvious mistakes early so the agent gets
// a clear "blocked" signal instead of an opaque sandbox denial.
//
// Known bypasses (deliberately not handled here, since allowOnly catches them):
//   - `bash -c '...'` and other inline shell wrappers
//   - command substitution: `$(...)`, backticks
//   - `eval` of dynamically constructed strings
//   - symlink escape: a path inside the worktree that points outside
//   - glob expansion that resolves to paths outside the worktree at runtime
import path from "node:path";
import process from "node:process";

function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buf += chunk;
    });
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", (err) => reject(err));
  });
}

function block(reason) {
  process.stdout.write(JSON.stringify({ decision: "block", reason }));
  process.exit(0);
}

function splitSegments(command) {
  return command.split(/&&|\|\||;|\||\n/g);
}

function tokenize(segment) {
  const tokens = [];
  let cur = "";
  let quote = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur.length > 0) {
        tokens.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur.length > 0) tokens.push(cur);
  return tokens;
}

const INSTALL_RE = /\b(pnpm|npm|yarn)\s+(install|i|add)\b/;
const SECRET_RE = /(^|[\s/'"=])(\.env(\.[\w-]+)?|MINIONS_TOKEN|[\w./-]+\.pem)(\b|$)/;

function checkInstall(segment) {
  if (INSTALL_RE.test(segment)) {
    return "deps cache should already cover; if missing run engine restart, do not install per-session";
  }
  return null;
}

function checkForcePush(tokens) {
  const giIdx = tokens.indexOf("git");
  if (giIdx === -1) return null;
  if (tokens[giIdx + 1] !== "push") return null;

  const args = tokens.slice(giIdx + 2);
  const flags = new Set();
  const positional = [];
  for (const a of args) {
    if (a.startsWith("-")) {
      flags.add(a);
    } else {
      positional.push(a);
    }
  }

  const hasForceFlag =
    flags.has("--force") || flags.has("-f") || flags.has("--force-with-lease");

  const dangerousRefspec = positional
    .slice(1)
    .find((p) => p.startsWith("+") || p.startsWith(":"));

  if (!hasForceFlag && !dangerousRefspec) return null;

  const remote = positional[0];
  const refspecs = positional.slice(1);
  const slug = process.env["MINIONS_SLUG"];
  const expected = `minions/${slug}`;

  if (remote !== "origin") {
    return `force push to non-origin remote: ${remote ?? "<none>"}`;
  }

  if (!slug) {
    return "force push blocked: MINIONS_SLUG not set";
  }

  if (refspecs.length === 0) {
    return `force push without refspec; expected ${expected}`;
  }

  for (const spec of refspecs) {
    const stripped = spec.startsWith("+") ? spec.slice(1) : spec;
    let dst;
    if (stripped.includes(":")) {
      const parts = stripped.split(":");
      const src = parts[0];
      dst = parts[1];
      if (src === "") {
        return `force push delete refspec: ${spec}`;
      }
    } else {
      dst = stripped;
    }
    if (dst !== expected) {
      return `force push targets non-session ref: ${spec} (expected ${expected})`;
    }
  }

  return null;
}

function checkRmRf(tokens) {
  const rmIdx = tokens.indexOf("rm");
  if (rmIdx === -1) return null;

  const args = tokens.slice(rmIdx + 1);
  let recursive = false;
  const paths = [];
  for (const a of args) {
    if (a.startsWith("--")) {
      if (a === "--recursive") recursive = true;
      continue;
    }
    if (a.startsWith("-")) {
      if (a.includes("r") || a.includes("R")) recursive = true;
      continue;
    }
    paths.push(a);
  }
  if (!recursive) return null;

  const worktree = process.env["MINIONS_WORKTREE"];
  if (!worktree) {
    return "rm -rf blocked: MINIONS_WORKTREE not set";
  }

  for (const p of paths) {
    const resolved = path.resolve(worktree, p);
    if (resolved === worktree) {
      return `rm -rf targets the worktree root itself: ${p}`;
    }
    if (!resolved.startsWith(worktree + path.sep)) {
      return `rm -rf targets path outside worktree: ${p}`;
    }
  }
  return null;
}

function checkSecret(segment) {
  if (SECRET_RE.test(segment)) {
    return "references a secret file pattern; aborting";
  }
  return null;
}

async function main() {
  let raw;
  try {
    raw = await readStdin();
  } catch {
    process.exit(0);
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }
  if (!payload || payload.tool_name !== "Bash") process.exit(0);
  const command = payload.tool_input?.command;
  if (typeof command !== "string") process.exit(0);

  for (const seg of splitSegments(command)) {
    const tokens = tokenize(seg);
    const checks = [
      () => checkInstall(seg),
      () => checkForcePush(tokens),
      () => checkRmRf(tokens),
      () => checkSecret(seg),
    ];
    for (const check of checks) {
      const reason = check();
      if (reason) block(reason);
    }
  }
  process.exit(0);
}

main();
