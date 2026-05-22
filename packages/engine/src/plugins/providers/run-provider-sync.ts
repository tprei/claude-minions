import type { RuntimeBackend } from "../runtime-backend.js";
import type { ProviderEvent, ProviderPlugin } from "../provider-plugin.js";
import { runProvider, type RunProviderOptions } from "./run-provider.js";

export interface ProviderRunSummary {
  finalReceived: boolean;
  fatalError?: { source?: string; message: string };
  sessionRef?: string;
}

// Consumes a provider run to completion and reports the outcome. Unlike
// RunOrchestrator it dispatches no task-lifecycle transitions and does no
// workspace cleanup — the caller owns both.
export async function runProviderToCompletion(
  runtime: RuntimeBackend,
  sessionId: string,
  provider: ProviderPlugin,
  opts: RunProviderOptions,
  onEvent?: (event: ProviderEvent) => void,
): Promise<ProviderRunSummary> {
  let finalReceived = false;
  let fatalError: { source?: string; message: string } | undefined;
  let sessionRef: string | undefined;

  for await (const item of runProvider(runtime, sessionId, provider, opts)) {
    if (item.kind === "offset") continue;
    const event = item.event;
    onEvent?.(event);
    if (event.kind === "error" && !event.recoverable) {
      fatalError = { message: event.message, ...(event.source !== undefined ? { source: event.source } : {}) };
      continue;
    }
    if (event.kind === "final") {
      finalReceived = true;
      sessionRef = event.sessionRef || undefined;
    }
  }

  const summary: ProviderRunSummary = { finalReceived };
  if (fatalError !== undefined) summary.fatalError = fatalError;
  if (sessionRef !== undefined) summary.sessionRef = sessionRef;
  return summary;
}
