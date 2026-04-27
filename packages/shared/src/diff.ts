export interface DiffStat {
  path: string;
  additions: number;
  deletions: number;
  status: "added" | "modified" | "deleted" | "renamed" | "untracked";
  oldPath?: string;
}

export interface WorkspaceDiff {
  sessionSlug: string;
  baseSha?: string;
  headSha?: string;
  patch: string;
  stats: DiffStat[];
  truncated: boolean;
  byteSize: number;
  generatedAt: string;
}
