import type { FastifyInstance, FastifyRequest } from "fastify";
import { simpleGit } from "simple-git";
import type { RepoBinding } from "@minions/shared";
import type { EngineContext } from "../../context.js";
import { EngineError } from "../../errors.js";
import { workspacePaths } from "../../workspace/paths.js";
import { barePath } from "../../workspace/worktree.js";

export type GitRunner = (barePath: string, args: string[]) => Promise<string>;

const TTL_MS = 60_000;
interface Entry {
  files: string[];
  cachedAt: number;
}
const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<string[]>>();

const defaultRunner: GitRunner = (bare, args) => simpleGit(bare).raw(args);

export function __resetFileCache(): void {
  cache.clear();
  inflight.clear();
}

async function getFileList(
  repo: RepoBinding,
  bare: string,
  runner: GitRunner = defaultRunner,
): Promise<string[]> {
  const now = Date.now();
  const hit = cache.get(repo.id);
  if (hit && now - hit.cachedAt < TTL_MS) {
    return hit.files;
  }
  const pending = inflight.get(repo.id);
  if (pending) return pending;

  const promise = (async () => {
    const out = await runner(bare, [
      "ls-tree",
      "-r",
      "--name-only",
      repo.defaultBranch ?? "main",
    ]);
    const files = out.split("\n").filter((line) => line.length > 0);
    cache.set(repo.id, { files, cachedAt: Date.now() });
    return files;
  })();

  inflight.set(repo.id, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(repo.id);
  }
}

export function fuzzyMatch(files: string[], q: string | undefined, limit: number): string[] {
  if (!q || q.length === 0) return files.slice(0, limit);
  const needle = q.toLowerCase();
  const scored: { path: string; score: number }[] = [];
  for (const p of files) {
    const idx = p.toLowerCase().indexOf(needle);
    if (idx < 0) continue;
    scored.push({ path: p, score: idx * 1000 + p.length });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, limit).map((s) => s.path);
}

interface FilesQuery {
  q?: string;
  limit?: string;
}

export function registerRepoRoutes(
  app: FastifyInstance,
  ctx: EngineContext,
  options?: { runner?: GitRunner },
): void {
  const runner = options?.runner ?? defaultRunner;
  app.get(
    "/api/repos/:id/files",
    async (req: FastifyRequest<{ Params: { id: string }; Querystring: FilesQuery }>, reply) => {
      const { id } = req.params;
      const repo = ctx.getRepo(id);
      if (!repo) {
        throw new EngineError("not_found", `Repo ${id} not found`);
      }

      const q = req.query.q;
      let limit = 50;
      if (req.query.limit !== undefined) {
        const n = Number(req.query.limit);
        if (!Number.isInteger(n) || n < 1 || n > 200) {
          throw new EngineError("bad_request", "limit must be an integer between 1 and 200");
        }
        limit = n;
      }

      const bare = barePath(workspacePaths(ctx.workspaceDir).repos, repo.id);
      const files = await getFileList(repo, bare, runner);
      const items = fuzzyMatch(files, q, limit);
      await reply.send({ items });
    },
  );
}
