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
}

export interface RuntimeBackend {
  start(spec: RuntimeStartSpec): Promise<RuntimeStartResult>;
  stop(sessionId: string): Promise<void>;
  probe(sessionId: string): Promise<RuntimeProbeState>;
  attach(sessionId: string, opts?: RuntimeAttachOptions): AsyncIterable<RuntimeOutputChunk>;
}
