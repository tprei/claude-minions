export type EntrypointKind = "github-webhook" | "linear-webhook" | "slack-event" | "email" | "custom";

export interface Entrypoint {
  id: string;
  kind: EntrypointKind;
  label: string;
  enabled: boolean;
  url?: string;
  secret?: string;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface RegisterEntrypointRequest {
  kind: EntrypointKind;
  label: string;
  config?: Record<string, unknown>;
}
