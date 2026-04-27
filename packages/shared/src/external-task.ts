export type ExternalSource = "github-issue" | "github-pr-comment" | "linear" | "slack" | "email" | "custom";

export interface ExternalTask {
  id: string;
  source: ExternalSource;
  externalId: string;
  title: string;
  body: string;
  url?: string;
  sessionSlug?: string;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface IngestExternalTaskRequest {
  source: ExternalSource;
  externalId: string;
  title: string;
  body: string;
  url?: string;
  prompt?: string;
  mode?: "task" | "review" | "ship";
  repoId?: string;
  metadata?: Record<string, unknown>;
}
