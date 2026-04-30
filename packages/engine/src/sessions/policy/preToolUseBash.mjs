#!/usr/bin/env node
import path from "node:path";
import process from "node:process";

const DEPS_INSTALL_TOOLS = new Set(["pnpm", "npm", "yarn"]);
const DEPS_INSTALL_VERBS = new Set(["install", "i", "add", "ci"]);
const FORCE_FLAGS = new Set([
  "--force",
  "-f",
  "--force-with-lease",
  "--force-if-includes",
]);
const DANGEROUS_PATH_LITERALS = new Set([
  "/",
  "~",
  "$HOME",
  "*",
  ".",
  "..",
]);

const SECRET_REDIR_RE =
  /(>|>>|&>)\s*['"]?(\.env\b|\.env\.\S+|MINIONS_TOKEN\b|\S+\.pem)/;
const SECRET_TEE_RE =
  /\b(tee|dd\s+of=)\s+\S*(\.env\b|\.env\.\S+|MINIONS_TOKEN\b|\.pem\b)/;

function splitSegments(cmd) {
  const segments = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    const next = cmd[i + 1];
    if (!inDouble && c === "'") {
      inSingle = !inSingle;
      current += c;
      continue;
    }
    if (!inSingle && c === '"') {
      inDouble = !inDouble;
      current += c;
      continue;
    }
    if (!inSingle && !inDouble) {
      if ((c === "&" && next === "&") || (c === "|" && next === "|")) {
        segments.push(current);
        current = "";
        i++;
        continue;
      }
      if (c === "|" || c === ";") {
        segments.push(current);
        current = "";
        continue;
      }
    }
    current += c;
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

function tokenize(segment) {
  const tokens = [];
  let current = "";
  let hasContent = false;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (!inDouble && c === "'") {
      inSingle = !inSingle;
      hasContent = true;
      continue;
    }
    if (!inSingle && c === '"') {
      inDouble = !inDouble;
      hasContent = true;
      continue;
    }
    if (!inSingle && !inDouble && /\s/.test(c)) {
      if (hasContent) {
        tokens.push(current);
        current = "";
        hasContent = false;
      }
      continue;
    }
    current += c;
    hasContent = true;
  }
  if (hasContent) tokens.push(current);
  return tokens;
}

function checkDepsInstall(tokens) {
  if (tokens.length < 2) return null;
  if (!DEPS_INSTALL_TOOLS.has(tokens[0])) return null;
  if (!DEPS_INSTALL_VERBS.has(tokens[1])) return null;
  return "deps cache should already cover; if missing run engine restart, do not install per-session";
}

function checkForcePush(tokens) {
  if (tokens[0] !== "git") return null;
  if (!tokens.includes("push")) return null;
  const isForce = tokens.some((t) => FORCE_FLAGS.has(t));
  if (!isForce) return null;

  const slug = process.env.MINIONS_SLUG;
  if (!slug) {
    return "force push blocked: MINIONS_SLUG missing, cannot validate target branch";
  }

  const pushIdx = tokens.indexOf("push");
  const positional = tokens.slice(pushIdx + 1).filter((t) => !t.startsWith("-"));
  if (positional.length < 2) {
    return "force push blocked: must specify both remote and ref explicitly";
  }
  const [remote, ref] = positional;
  if (remote !== "origin") {
    return `force push blocked: only allowed to origin (got ${remote})`;
  }
  const allowedRefs = new Set([
    `minions/${slug}`,
    `refs/heads/minions/${slug}`,
    `HEAD:refs/heads/minions/${slug}`,
    `HEAD:minions/${slug}`,
  ]);
  if (!allowedRefs.has(ref)) {
    return `force push blocked: ref must be your minion branch (minions/${slug})`;
  }
  return null;
}

function hasRmRfFlags(flagTokens) {
  let hasR = false;
  let hasF = false;
  for (const t of flagTokens) {
    if (t === "--recursive") {
      hasR = true;
      continue;
    }
    if (t === "--force") {
      hasF = true;
      continue;
    }
    if (t.startsWith("--")) continue;
    if (!t.startsWith("-")) continue;
    const flags = t.slice(1);
    if (flags.includes("r") || flags.includes("R")) hasR = true;
    if (flags.includes("f")) hasF = true;
  }
  return hasR && hasF;
}

function checkRmRf(tokens) {
  if (tokens[0] !== "rm") return null;
  const rest = tokens.slice(1);
  const flagTokens = rest.filter((t) => t.startsWith("-"));
  if (!hasRmRfFlags(flagTokens)) return null;

  const args = rest.filter((t) => !t.startsWith("-"));
  const worktree = process.env.MINIONS_WORKTREE;

  for (const arg of args) {
    if (DANGEROUS_PATH_LITERALS.has(arg)) {
      return `rm -rf blocked: dangerous path literal "${arg}"`;
    }
    if (!worktree) {
      return "rm -rf blocked: MINIONS_WORKTREE unset, cannot validate target";
    }
    const target = path.resolve(worktree, arg);
    const rel = path.relative(worktree, target);
    if (rel === "") continue;
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      return `rm -rf blocked: ${arg} is outside the worktree`;
    }
  }
  return null;
}

function checkSecretWrite(segment) {
  if (SECRET_REDIR_RE.test(segment) || SECRET_TEE_RE.test(segment)) {
    return "blocked write to .env / MINIONS_TOKEN / *.pem path";
  }
  return null;
}

function evaluateCommand(cmd) {
  const segments = splitSegments(cmd);
  for (const segment of segments) {
    const tokens = tokenize(segment);
    if (tokens.length === 0) continue;

    const depsReason = checkDepsInstall(tokens);
    if (depsReason) return depsReason;

    const forceReason = checkForcePush(tokens);
    if (forceReason) return forceReason;

    const rmReason = checkRmRf(tokens);
    if (rmReason) return rmReason;

    const secretReason = checkSecretWrite(segment);
    if (secretReason) return secretReason;
  }
  return null;
}

async function readStdin() {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk.toString("utf8");
  }
  return raw;
}

async function main() {
  let raw;
  try {
    raw = await readStdin();
  } catch {
    process.exit(0);
    return;
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
    return;
  }

  if (!payload || typeof payload !== "object") {
    process.exit(0);
    return;
  }
  if (payload.tool_name !== "Bash") {
    process.exit(0);
    return;
  }

  const cmd = String(payload.tool_input?.command ?? "");
  if (cmd.length === 0) {
    process.exit(0);
    return;
  }

  const reason = evaluateCommand(cmd);
  if (reason) {
    process.stdout.write(JSON.stringify({ decision: "block", reason }));
  }
  process.exit(0);
}

main().catch(() => {
  process.exit(0);
});
