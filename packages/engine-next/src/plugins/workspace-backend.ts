export type WorkspaceMode = "worktree" | "existing";

export interface WorkspaceCreateSpec {
  workflowId: string;
  taskId: string;
  branch: string;
  baseRef?: string;
  mode?: WorkspaceMode;
  resetBranch?: boolean;
}

export interface WorkspaceHandle {
  workspaceId: string;
  mode: WorkspaceMode;
  path: string;
  containerPath: string;
  branch: string;
}

export interface WorkspaceBackend {
  create(spec: WorkspaceCreateSpec): Promise<WorkspaceHandle>;
  get(workspaceId: string): Promise<WorkspaceHandle | undefined>;
  cleanup(workspaceId: string): Promise<void>;
}

export class WorkspaceError extends Error {
  constructor(
    public code: "path_escape" | "git_failed" | "not_found" | "lock_timeout",
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}

import { createHash } from "node:crypto";

export function slugify(s: string): string {
  const sanitized = s.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
  const hash = createHash("sha256").update(s).digest("hex").slice(0, 6);
  return sanitized.length > 0 ? `${sanitized}-${hash}` : hash;
}
