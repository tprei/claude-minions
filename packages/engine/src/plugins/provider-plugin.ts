import type { Artifact, WorkflowKind } from "../domain/types.js";
import type { ProviderEvent } from "@minions/shared";

export type { ProviderEvent };

export interface ProviderCapabilities {
  resume: boolean;
  mcp: boolean;
  structuredOutput: boolean;
  oauthLogin: boolean;
  streamJson: boolean;
  sessionRefFormat: "uuid" | "opaque";
}

export interface ProviderPrepareSpec {
  taskId: string;
  workflowId: string;
  prompt: string;
  dependencyArtifacts: Artifact[];
  workflowKind?: WorkflowKind;
}

export interface ProviderResumeSpec {
  taskId: string;
  workflowId: string;
  sessionRef: string;
  prompt: string;
  workflowKind?: WorkflowKind;
}

export interface ProviderInvocation {
  command: string[];
  env?: Record<string, string>;
  providerType: string;
}

export interface ProviderPlugin {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  prepare(spec: ProviderPrepareSpec): Promise<ProviderInvocation>;
  resume(spec: ProviderResumeSpec): Promise<ProviderInvocation>;
  parseFrame(line: string): ProviderEvent[];
  loginStatus(): Promise<{ loggedIn: boolean; details?: string }>;
}
