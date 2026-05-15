import { execFileSync } from "node:child_process";

const ZERO_SHA = /^0{40}$/;

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function tryGit(args) {
  try {
    return git(args);
  } catch {
    return null;
  }
}

function resolveBaseRef() {
  const explicitBase = process.env.CHECK_DOC_ADDITIONS_BASE?.trim();
  if (explicitBase && !ZERO_SHA.test(explicitBase)) return explicitBase;

  const baseBranch = process.env.GITHUB_BASE_REF?.trim();
  if (baseBranch) return `origin/${baseBranch}`;

  const eventBefore = process.env.GITHUB_EVENT_BEFORE?.trim();
  if (eventBefore && !ZERO_SHA.test(eventBefore)) return eventBefore;

  if (tryGit(["rev-parse", "--verify", "origin/main^{commit}"])) return "origin/main";
  if (tryGit(["rev-parse", "--verify", "HEAD^^{commit}"])) return "HEAD^";
  return null;
}

function parseNameStatus(line) {
  const parts = line.split("\t");
  const status = parts[0];
  const path = status.startsWith("R") || status.startsWith("C") ? parts[2] : parts[1];
  return { status, path };
}

const root = git(["rev-parse", "--show-toplevel"]);
process.chdir(root);

const baseRef = resolveBaseRef();
const failures = [];
const checked = [];

if (baseRef) {
  if (!tryGit(["rev-parse", "--verify", `${baseRef}^{commit}`])) {
    console.error(`Cannot resolve docs-addition base ref: ${baseRef}`);
    process.exit(2);
  }

  const output = tryGit(["diff", "--name-status", "--diff-filter=ACR", `${baseRef}...HEAD`]);
  checked.push(`${baseRef}...HEAD`);
  for (const line of output ? output.split(/\r?\n/) : []) {
    const { status, path } = parseNameStatus(line);
    if (path?.startsWith("docs/")) failures.push(`${status}\t${path}`);
  }
}

const untrackedDocs = tryGit(["ls-files", "--others", "--exclude-standard", "docs/"]);
for (const path of untrackedDocs ? untrackedDocs.split(/\r?\n/) : []) {
  if (path) failures.push(`??\t${path}`);
}

if (failures.length > 0) {
  console.error("New docs/ files are banned. Move generated notes to workflow artifacts or update an existing tracked document.");
  console.error(`Checked: ${checked.length > 0 ? checked.join(", ") : "working tree"}`);
  for (const failure of failures) console.error(failure);
  process.exit(1);
}
