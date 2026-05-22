import type { RuntimeProbeState } from "../application/recovery.js";

export interface RuntimeStartSpec {
  taskId: string;
  workflowId: string;
  command: string[];
  env?: Record<string, string>;
  workspacePath?: string;
}

export interface RuntimeStartResult {
  sessionId: string;
  runtimeType: string;
}

export interface RuntimeOutputChunk {
  sessionId: string;
  offset: number;
  bytes: Uint8Array;
}

export interface RuntimeAttachOptions {
  fromOffset?: number;
  signal?: AbortSignal;
  idleTimeoutMs?: number;
}

export class RuntimeIdleTimeoutError extends Error {
  readonly sessionId: string;
  readonly idleTimeoutMs: number;

  constructor(sessionId: string, idleTimeoutMs: number) {
    super(`runtime session ${sessionId} produced no output for ${idleTimeoutMs}ms`);
    this.name = "RuntimeIdleTimeoutError";
    this.sessionId = sessionId;
    this.idleTimeoutMs = idleTimeoutMs;
  }
}

export interface RuntimeBackend {
  start(spec: RuntimeStartSpec): Promise<RuntimeStartResult>;
  stop(sessionId: string): Promise<void>;
  probe(sessionId: string): Promise<RuntimeProbeState>;
  attach(sessionId: string, opts?: RuntimeAttachOptions): AsyncIterable<RuntimeOutputChunk>;
}
