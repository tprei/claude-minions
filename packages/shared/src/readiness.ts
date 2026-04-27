export type ReadinessStatus = "ready" | "blocked" | "pending" | "unknown";
export type ReadinessCheckStatus = "ok" | "blocked" | "warn" | "pending" | "unknown";

export interface ReadinessCheck {
  id: string;
  label: string;
  status: ReadinessCheckStatus;
  detail?: string;
}

export interface MergeReadiness {
  sessionSlug: string;
  status: ReadinessStatus;
  checks: ReadinessCheck[];
  computedAt: string;
}

export interface ReadinessSummary {
  total: number;
  ready: number;
  blocked: number;
  pending: number;
  unknown: number;
  bySession: { slug: string; status: ReadinessStatus }[];
}
