import path from "node:path";

export interface WorkspacePaths {
  db: string;
  repos: string;
  depsCache: (repoId: string) => string;
  worktree: (slug: string) => string;
  home: (provider: string) => string;
  uploads: (slug: string) => string;
  audit: string;
  replyQueueDir: string;
  screenshots: (slug: string) => string;
  session: (slug: string) => string;
}

export function workspacePaths(root: string): WorkspacePaths {
  return {
    db: path.join(root, "engine.db"),
    repos: path.join(root, ".repos"),
    depsCache: (repoId) => path.join(root, `.repos/v3-${repoId}-deps`),
    worktree: (slug) => path.join(root, slug),
    home: (provider) => path.join(root, "home", provider),
    uploads: (slug) => path.join(root, "uploads", slug),
    audit: path.join(root, "audit", "audit.log"),
    replyQueueDir: path.join(root, "reply-queue"),
    screenshots: (slug) => path.join(root, slug, ".minions", "screenshots"),
    session: (slug) => path.join(root, slug, ".minions"),
  };
}
