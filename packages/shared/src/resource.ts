export interface ResourceSnapshot {
  timestamp: string;
  cgroupAware: boolean;
  cpu: {
    usagePct: number;
    limitCores: number;
    cores: number;
  };
  memory: {
    usedBytes: number;
    limitBytes: number;
    rssBytes: number;
  };
  disk: {
    usedBytes: number;
    totalBytes: number;
    workspacePath: string;
    workspaceUsedBytes: number;
  };
  eventLoop: {
    lagMs: number;
  };
  sessions: {
    total: number;
    running: number;
    waiting: number;
  };
}
