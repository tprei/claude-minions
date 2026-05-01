import type { EngineContext } from "../context.js";
import type { Logger } from "../logger.js";

export interface EditPullRequestBaseArgs {
  ctx: EngineContext;
  repoId: string;
  prNumber: number;
  newBase: string;
  log: Logger;
}

export type EditPullRequestBaseFn = (args: EditPullRequestBaseArgs) => Promise<void>;

export async function editPullRequestBase(args: EditPullRequestBaseArgs): Promise<void> {
  await args.ctx.github.editPRBase(args.repoId, args.prNumber, args.newBase);
}
