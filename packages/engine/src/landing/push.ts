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
  if (/non-fast-forward|fetch first|stale info|rejected/i.test(message)) {
    if (/conflict/i.test(message)) return "conflict";
  }
  if (/rebase|merge conflict|conflict/i.test(message)) {
    return "conflict";
  }
  for (const pattern of TRANSIENT_PATTERNS) {
    if (pattern.test(message)) return "transient";
  }
  return "fatal";
}

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
  try {
    await git.push(["-u", "--force-with-lease", "origin", branch]);
  } catch (err) {
    const message = (err as Error).message;
    const classification = classifyPushError(message);
    if (classification === "transient") {
      throw new EngineError(
        "transient_push_error",
        `transient push error for ${branch}: ${message}`,
        { branch, worktreePath },
      );
    }
    throw new EngineError("upstream", `failed to push ${branch} to origin: ${message}`);
  }
}
