import { spawn } from "node:child_process";
import type { Logger } from "../logger.js";
import { parseGithubRemote } from "../github/parseRemote.js";

export type RunGhFn = (args: string[], opts: { cwd: string; log: Logger }) => Promise<string>;

export interface EditPullRequestBaseArgs {
  cwd: string;
  prNumber: number;
  newBase: string;
  remote: string;
  log: Logger;
}

export type EditPullRequestBaseFn = (args: EditPullRequestBaseArgs) => Promise<void>;

export function buildEditPullRequestBaseArgs(
  owner: string,
  repo: string,
  prNumber: number,
  newBase: string,
): string[] {
  return ["api", "-X", "PATCH", `repos/${owner}/${repo}/pulls/${prNumber}`, "-f", `base=${newBase}`];
}

export function createEditPullRequestBase(runGh: RunGhFn): EditPullRequestBaseFn {
  return async ({ cwd, prNumber, newBase, remote, log }) => {
    const parsed = parseGithubRemote(remote);
    if (!parsed) {
      throw new Error(`unable to parse owner/repo from remote: ${remote}`);
    }
    const args = buildEditPullRequestBaseArgs(parsed.owner, parsed.repo, prNumber, newBase);
    await runGh(args, { cwd, log });
  };
}

export const defaultRunGh: RunGhFn = (args, { cwd, log }) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn("gh", args, { cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        log.info("gh ok", { args: args.join(" ") });
        resolve(stdout.trim());
      } else {
        reject(new Error(`gh ${args.join(" ")} exited ${code}: ${stderr.trim() || stdout.trim()}`));
      }
    });
  });
