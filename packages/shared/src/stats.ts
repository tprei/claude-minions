import type { SessionMode, SessionStatus } from "./session.js";

export interface GlobalStats {
  totals: {
    sessions: number;
    running: number;
    waiting: number;
    completed: number;
    failed: number;
    turns: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    costUsd: number;
    toolCalls: number;
  };
  uptimeSec: number;
}

export type ModeStats = Record<SessionMode, {
  total: number;
  running: number;
  completed: number;
  failed: number;
  costUsd: number;
}>;

export interface RecentSession {
  slug: string;
  title: string;
  mode: SessionMode;
  status: SessionStatus;
  updatedAt: string;
  costUsd: number;
}

export interface RecentStats {
  sessions: RecentSession[];
  windowHours: number;
}
