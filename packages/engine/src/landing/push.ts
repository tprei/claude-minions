import simpleGit from "simple-git";
import type { Logger } from "../logger.js";
import { EngineError } from "../errors.js";
import { gitAuthEnv } from "../ci/askpass.js";

const TRANSIENT_PATTERNS: RegExp[] = [
  /\bECONNRESET\b/,
  /\bETIMEDOUT\b/,
  /\bENOTFOUND\b/,
  /\bECONNREFUSED\b/,
  /\bEAI_AGAIN\b/,
  /\bEPIPE\b/,
  /connection timed out/i,
  /could not resolve host/i,
  /unexpectedly closed the connection/i,
  /the remote end hung up unexpectedly/i,
  /early eof/i,
  /rpc failed/i,
  /\bhttp\/\d(?:\.\d)? \b50\d\b/i,
  /\b50[0-9]\b\s*(?:bad gateway|service unavailable|gateway timeout|internal server error)/i,
  /\bbad gateway\b/i,
  /\bservice unavailable\b/i,
  /\bgateway timeout\b/i,
  /\binternal server error\b/i,
  /\bauthentication failed\b/i,
];

export function classifyPushError(message: string): "transient" | "conflict" | "fatal" {
  // A real merge conflict surfaces with explicit conflict markers in the message.
  // Bare "rejected" / "non-fast-forward" / "stale info" / "fetch first" are race
  // signals — the remote-tracking lease was outdated, but the new tip is usually
  // still a fast-forward of ours. They are transient and self-correct after a
  // fresh fetch + retry. Only escalate to "conflict" when the message also
  // mentions an actual conflict.
  if (/non-fast-forward|fetch first|stale info|rejected/i.test(message)) {
    if (/conflict/i.test(message)) return "conflict";
    return "transient";
  }
  if (/rebase|merge conflict|conflict/i.test(message)) {
    return "conflict";
  }
  for (const pattern of TRANSIENT_PATTERNS) {
    if (pattern.test(message)) return "transient";
  }
  return "fatal";
}

const PUSH_RETRY_DELAY_MS = 250;

export async function pushBranch(
  worktreePath: string,
  branch: string,
  log: Logger,
): Promise<void> {
  // simple-git's safe-askpass guard refuses any GIT_ASKPASS in the env we hand it,
  // even via .env(). Opt in: the shim is ours and emits the GitHub App installation
  // token, never an interactive prompt.
  const git = simpleGit({
    baseDir: worktreePath,
    unsafe: { allowUnsafeAskPass: true },
  }).env(gitAuthEnv());
  log.info("pushing branch to origin", { worktreePath, branch });

  const firstError = await tryPush(git, branch);
  if (firstError === null) return;

  const firstClass = classifyPushError(firstError);
  if (firstClass !== "transient") {
    throw new EngineError("upstream", `failed to push ${branch} to origin: ${firstError}`);
  }

  // Transient on first attempt — refresh the remote-tracking ref so
  // --force-with-lease has an up-to-date lease, then retry once. This handles
  // the common race where a descendant's worktree-add ran
  // `git fetch origin <branch>:<branch>` and bumped our local origin/<branch>
  // view, leaving the lease stale relative to GitHub's actual HEAD.
  log.warn("push hit transient error; refreshing remote-tracking and retrying", {
    branch,
    worktreePath,
    err: firstError,
  });
  try {
    await git.raw(["fetch", "origin", branch]);
  } catch (fetchErr) {
    log.warn("fetch before push retry failed; retrying push anyway", {
      branch,
      err: (fetchErr as Error).message,
    });
  }
  await new Promise<void>((resolve) => setTimeout(resolve, PUSH_RETRY_DELAY_MS));

  const secondError = await tryPush(git, branch);
  if (secondError === null) return;

  const secondClass = classifyPushError(secondError);
  if (secondClass === "transient") {
    // Persistent transient — let the caller's retry policy (re-enqueued
    // dag-tick in onTerminal) take over instead of marking the node failed.
    throw new EngineError(
      "transient_push_error",
      `transient push error for ${branch} after one inline retry: ${secondError}`,
      { branch, worktreePath },
    );
  }
  throw new EngineError("upstream", `failed to push ${branch} to origin: ${secondError}`);
}

async function tryPush(
  git: ReturnType<typeof simpleGit>,
  branch: string,
): Promise<string | null> {
  try {
    await git.push(["-u", "--force-with-lease", "origin", branch]);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}
