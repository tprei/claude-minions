export type FeatureFlag =
  | "workflows"
  | "workflow-planning"
  | "task-transitions"
  | "scheduler"
  | "provider-orchestration"
  | "transcripts"
  | "recovery"
  | "restack"
  | "quality-gates"
  | "github-prs"
  | "ci-babysit"
  | "local-finalize"
  | "push"
  | "supervisor"
  | "audit"
  | "observability"
  | "pwa-connections"
  | "snapshot-cache"
  | "status-rendering"
  | "slash-commands"
  | "voice-input"
  | "runtime-diagnostics";

export interface RepoBinding {
  id: string;
  label: string;
  remote?: string;
  defaultBranch?: string;
}

export interface PendingFeature {
  flag: FeatureFlag;
  reason: string;
}

export interface VersionInfo {
  apiVersion: string;
  libraryVersion: string;
  buildSha: string;
  features: FeatureFlag[];
  featuresPending: PendingFeature[];
  provider: string;
  providers: string[];
  repos: RepoBinding[];
  pluginSet: string[];
  startedAt: string;
}
