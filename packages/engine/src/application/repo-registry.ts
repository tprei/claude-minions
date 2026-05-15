import { join } from "node:path";

export interface RepoBindingInput {
  id: string;
  label: string;
  remote?: string;
  defaultBranch?: string;
  localPath?: string;
}

export interface ResolvedRepoBinding {
  id: string;
  label: string;
  remote?: string;
  defaultBranch: string;
  localPath: string;
  github?: { owner: string; repo: string };
}

export interface RepoRegistry {
  all(): ResolvedRepoBinding[];
  get(repoId: string): ResolvedRepoBinding | undefined;
  require(repoId: string): ResolvedRepoBinding;
}

export interface BuildRegistryOptions {
  reposRoot: string;
}

const GITHUB_REMOTE = /^(?:https:\/\/github\.com\/|git@github\.com:)([^/]+)\/([^/.]+)(?:\.git)?\/?$/;

function parseGithubCoords(remote: string): { owner: string; repo: string } | undefined {
  const m = remote.match(GITHUB_REMOTE);
  if (!m) return undefined;
  return { owner: m[1]!, repo: m[2]! };
}

export function buildRepoRegistry(inputs: readonly RepoBindingInput[], opts: BuildRegistryOptions): RepoRegistry {
  if (inputs.length === 0) {
    throw new Error("repo registry requires at least one binding");
  }

  const byId = new Map<string, ResolvedRepoBinding>();
  for (const input of inputs) {
    if (!input.id || !input.label) {
      throw new Error(`repo binding missing id or label: ${JSON.stringify(input)}`);
    }
    if (byId.has(input.id)) {
      throw new Error(`duplicate repo binding id: ${input.id}`);
    }
    const resolved: ResolvedRepoBinding = {
      id: input.id,
      label: input.label,
      defaultBranch: input.defaultBranch ?? "main",
      localPath: input.localPath ?? join(opts.reposRoot, input.id),
    };
    if (input.remote !== undefined) {
      resolved.remote = input.remote;
      const github = parseGithubCoords(input.remote);
      if (github) resolved.github = github;
    }
    byId.set(resolved.id, resolved);
  }

  const ordered = Array.from(byId.values());

  return {
    all: () => ordered.slice(),
    get: (repoId) => byId.get(repoId),
    require: (repoId) => {
      const binding = byId.get(repoId);
      if (!binding) {
        throw new Error(`unknown repoId: ${repoId}`);
      }
      return binding;
    },
  };
}
