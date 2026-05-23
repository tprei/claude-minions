import type { WorkspaceBackend, WorkspaceCreateSpec, WorkspaceHandle } from "../workspace-backend.js";
import { slugify } from "../workspace-backend.js";

export class StubWorkspaceBackend implements WorkspaceBackend {
  private readonly handles = new Map<string, WorkspaceHandle>();

  resolveId(spec: Pick<WorkspaceCreateSpec, "repoId" | "workflowId" | "taskId">): string {
    return `stub-${slugify(spec.workflowId)}_${slugify(spec.taskId)}`;
  }

  async create(spec: WorkspaceCreateSpec): Promise<WorkspaceHandle> {
    const handle: WorkspaceHandle = {
      workspaceId: this.resolveId(spec),
      repoId: spec.repoId,
      mode: "existing",
      path: "/stub-workspace",
      containerPath: "/stub-workspace",
      branch: spec.branch,
    };
    this.handles.set(handle.workspaceId, handle);
    return handle;
  }

  async get(workspaceId: string): Promise<WorkspaceHandle | undefined> {
    return this.handles.get(workspaceId);
  }

  async cleanup(workspaceId: string): Promise<void> {
    this.handles.delete(workspaceId);
  }
}
