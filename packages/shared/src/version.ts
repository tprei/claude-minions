export type FeatureFlag =
  | "sessions"
  | "dags"
  | "ship"
  | "loops"
  | "variants"
  | "judge"
  | "checkpoints"
  | "memory"
  | "memory-mcp"
  | "audit"
  | "resources"
  | "push"
  | "external-tasks"
  | "runtime-overrides"
  | "github"
  | "quality-gates"
  | "readiness"
  | "ci-babysit"
  | "screenshots"
  | "diff"
  | "pr-preview"
  | "stack"
  | "split"
  | "voice-input";

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
  features: FeatureFlag[];
  featuresPending: PendingFeature[];
  provider: string;
  providers: string[];
  repos: RepoBinding[];
  startedAt: string;
}
