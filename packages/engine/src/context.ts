import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import type { Logger } from "./logger.js";
import type { EngineEnv } from "./env.js";
import type { EventBus } from "./bus/eventBus.js";
import type { KeyedMutex } from "./util/mutex.js";
import type { EngineMarker } from "./lifecycle/marker.js";

export interface SubsystemBootHook {
  (): Promise<void> | void;
}

export interface RouteRegistrar {
  (app: FastifyInstance): Promise<void> | void;
}

export interface EngineContext {
  env: EngineEnv;
  log: Logger;
  db: Database.Database;
  bus: EventBus;
  mutex: KeyedMutex;
  workspaceDir: string;
  previousMarker: EngineMarker | null;

  sessions: {
    create: (req: import("@minions/shared").CreateSessionRequest) => Promise<import("@minions/shared").Session>;
    get: (slug: string) => import("@minions/shared").Session | null;
    list: () => import("@minions/shared").Session[];
    listPaged: (opts: import("./store/repos/sessionRepo.js").ListSessionsOptions) => import("./store/repos/sessionRepo.js").ListSessionsResult;
    listWithTranscript: () => import("@minions/shared").SessionWithTranscript[];
    transcript: (slug: string, sinceSeq?: number) => import("@minions/shared").TranscriptEvent[];
    stop: (slug: string, reason?: string) => Promise<void>;
    close: (slug: string, removeWorktree?: boolean) => Promise<void>;
    delete: (slug: string) => Promise<void>;
    reply: (slug: string, text: string, attachments?: import("@minions/shared").AttachmentInput[]) => Promise<void>;
    setDagId: (slug: string, dagId: string) => void;
    setMetadata: (slug: string, patch: Record<string, unknown>) => void;
    markCompleted: (slug: string) => void;
    markWaitingInput: (slug: string, reason?: string) => void;
    appendAttention: (slug: string, flag: import("@minions/shared").AttentionFlag) => void;
    dismissAttention: (slug: string, kind: import("@minions/shared").AttentionFlag["kind"]) => import("@minions/shared").Session;
    kickReplyQueue: (slug: string) => Promise<boolean>;
    resumeAllActive: () => Promise<void>;
    diff: (slug: string) => Promise<import("@minions/shared").WorkspaceDiff>;
    screenshots: (slug: string) => Promise<import("@minions/shared").Screenshot[]>;
    screenshotPath: (slug: string, filename: string) => string;
    checkpoints: (slug: string) => import("@minions/shared").Checkpoint[];
    restoreCheckpoint: (slug: string, id: string) => Promise<void>;
    updateBucket: (slug: string, bucket: import("@minions/shared").SessionBucket | null) => void;
  };

  dags: {
    list: () => import("@minions/shared").DAG[];
    get: (id: string) => import("@minions/shared").DAG | null;
    splitNode: (req: import("@minions/shared").DAGSplitRequest) => Promise<import("@minions/shared").DAG>;
    onSessionTerminal: (sessionSlug: string) => Promise<void>;
    onSessionCiTerminal: (sessionSlug: string) => Promise<void>;
    retry: (dagId: string, nodeId: string) => Promise<void>;
    cancel: (dagId: string) => Promise<void>;
    forceLand: (dagId: string, nodeId: string) => Promise<void>;
    tryCreateFromTranscript: (slug: string) => Promise<{ created: boolean; dagId?: string }>;
  };

  ship: {
    advance: (slug: string, toStage?: import("@minions/shared").ShipStage, note?: string) => Promise<void>;
    onTurnCompleted: (slug: string) => Promise<void>;
    reconcileOnBoot: () => Promise<void>;
  };

  landing: {
    land: (slug: string, strategy?: "merge" | "squash" | "rebase", force?: boolean) => Promise<void>;
    openForReview: (slug: string) => Promise<import("@minions/shared").PRSummary | null>;
    retryRebase: (slug: string) => Promise<void>;
    onUpstreamMerged: (slug: string) => Promise<void>;
  };

  loops: {
    list: () => import("@minions/shared").LoopDefinition[];
    upsert: (def: Omit<import("@minions/shared").LoopDefinition, "id" | "createdAt" | "updatedAt" | "consecutiveFailures">) => import("@minions/shared").LoopDefinition;
    setEnabled: (id: string, enabled: boolean) => void;
    delete: (id: string) => void;
    tick: () => Promise<void>;
  };

  variants: {
    spawn: (req: import("@minions/shared").CreateVariantsRequest) => Promise<{ parentSlug: string; childSlugs: string[] }>;
    judge: (parentSlug: string, rubric?: string) => Promise<void>;
  };

  ci: {
    poll: (slug: string) => Promise<void>;
    onPrUpdated: (slug: string) => Promise<void>;
  };

  quality: {
    runForSession: (slug: string) => Promise<import("@minions/shared").QualityReport>;
    getReport: (slug: string) => import("@minions/shared").QualityReport | null;
  };

  readiness: {
    compute: (slug: string) => Promise<import("@minions/shared").MergeReadiness>;
    computeStack: (slug: string) => Promise<import("@minions/shared").MergeReadiness>;
    summary: () => import("@minions/shared").ReadinessSummary;
  };

  intake: {
    ingest: (req: import("@minions/shared").IngestExternalTaskRequest) => Promise<import("@minions/shared").ExternalTask>;
    list: () => import("@minions/shared").ExternalTask[];
  };

  runtime: {
    schema: () => import("@minions/shared").RuntimeConfigSchema;
    values: () => import("@minions/shared").RuntimeOverrides;
    effective: () => import("@minions/shared").RuntimeOverrides;
    update: (patch: import("@minions/shared").RuntimeOverrides) => Promise<void>;
  };

  memory: {
    list: (filter?: { status?: import("@minions/shared").MemoryStatus; kind?: import("@minions/shared").MemoryKind; q?: string; repoId?: string }) => import("@minions/shared").Memory[];
    get: (id: string) => import("@minions/shared").Memory | null;
    create: (req: import("@minions/shared").CreateMemoryRequest) => Promise<import("@minions/shared").Memory>;
    update: (id: string, patch: Partial<Pick<import("@minions/shared").Memory, "title" | "body" | "pinned">>) => Promise<import("@minions/shared").Memory>;
    review: (id: string, decision: import("@minions/shared").MemoryReviewCommand) => Promise<import("@minions/shared").Memory>;
    delete: (id: string) => Promise<void>;
    renderPreamble: (repoId?: string) => string;
  };

  audit: {
    record: (actor: string, action: string, target?: { kind: string; id: string }, detail?: Record<string, unknown>) => void;
    list: (limit?: number) => import("@minions/shared").AuditEvent[];
  };

  lifecycle: import("./lifecycle/index.js").LifecycleSubsystem;

  resource: {
    latest: () => import("@minions/shared").ResourceSnapshot | null;
    start: () => void;
    stop: () => void;
  };

  push: {
    vapidPublicKey: () => string | null;
    subscribe: (sub: import("@minions/shared").PushSubscriptionInfo) => Promise<void>;
    unsubscribe: (endpoint: string) => Promise<void>;
    notify: (sessionSlug: string, title: string, body: string, data?: Record<string, unknown>) => Promise<void>;
  };

  digest: {
    summarize: (slug: string) => Promise<string>;
  };

  github: {
    enabled: () => boolean;
    fetchPR: (repoId: string, prNumber: number) => Promise<import("@minions/shared").PullRequestPreview>;
  };

  stats: {
    global: () => import("@minions/shared").GlobalStats;
    modes: () => import("@minions/shared").ModeStats;
    recent: (hours?: number) => import("@minions/shared").RecentStats;
    promText: () => string;
  };

  cleanup: {
    selectCandidates: (opts: {
      olderThanDays: number;
      statuses: import("@minions/shared").CleanupableStatus[];
      limit: number;
      cursor?: string | null;
    }) => Promise<import("@minions/shared").CleanupCandidatesResponse>;
    preview: (
      req: import("@minions/shared").CleanupPreviewRequest,
    ) => Promise<import("@minions/shared").CleanupPreviewResponse>;
    execute: (
      req: import("@minions/shared").CleanupExecuteRequest,
    ) => Promise<import("@minions/shared").CleanupExecuteResponse>;
  };

  features: () => import("@minions/shared").FeatureFlag[];
  featuresPending: () => { flag: import("@minions/shared").FeatureFlag; reason: string }[];
  repos: () => import("@minions/shared").RepoBinding[];
  getRepo: (id: string) => import("@minions/shared").RepoBinding | null;

  shutdown: () => Promise<void>;
}
