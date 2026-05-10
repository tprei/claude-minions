import type { Artifact } from "../domain/types.js";

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
}

export interface ProviderResumeSpec {
  taskId: string;
  workflowId: string;
  sessionRef: string;
  prompt: string;
}

export interface ProviderInvocation {
  command: string[];
  env?: Record<string, string>;
  providerType: string;
}

export type ProviderEvent =
  | { kind: "assistant_text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_call"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; id: string; output: unknown; isError?: boolean }
  | { kind: "permission_request"; id: string; tool: string; input: unknown }
  | { kind: "usage"; inputTokens: number; outputTokens: number; cachedInputTokens?: number; reasoningTokens?: number; costUsd?: number }
  | { kind: "error"; recoverable: boolean; message: string; source?: string }
  | { kind: "final"; sessionRef: string; exitMetadata?: Record<string, unknown> };

export interface ProviderPlugin {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  prepare(spec: ProviderPrepareSpec): Promise<ProviderInvocation>;
  resume(spec: ProviderResumeSpec): Promise<ProviderInvocation>;
  parseFrame(line: string): ProviderEvent[];
  loginStatus(): Promise<{ loggedIn: boolean; details?: string }>;
}
