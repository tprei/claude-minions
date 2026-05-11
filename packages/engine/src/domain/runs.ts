export type NodeRunTerminalReason =
  | "completed"
  | "failed"
  | "cancelled"
  | "recovered"
  | "timeout"
  | "interrupted";

export interface NodeRun {
  id: string;
  taskId: string;
  attempt: number;
  providerType: string;
  runtimeType: string;
  runtimeSessionId: string;
  providerSessionRef?: string;
  outputOffset?: number;
  startedAt: string;
  endedAt?: string;
  terminalReason?: NodeRunTerminalReason;
  exitMetadata?: Record<string, unknown>;
}

export function appendRun(runs: NodeRun[], run: NodeRun): NodeRun[] {
  return [...runs, run];
}

export function getOpenRun(runs: NodeRun[]): NodeRun | undefined {
  for (let i = runs.length - 1; i >= 0; i--) {
    if (runs[i]!.endedAt === undefined) return runs[i];
  }
  return undefined;
}

export function closeLatestRun(
  runs: NodeRun[],
  terminalReason: NodeRunTerminalReason,
  endedAt: string,
): NodeRun[] {
  const open = getOpenRun(runs);
  if (!open) return runs;

  const realIndex = runs.indexOf(open);
  const closed: NodeRun = { ...open, endedAt, terminalReason };
  return [...runs.slice(0, realIndex), closed, ...runs.slice(realIndex + 1)];
}

export function patchOpenRun(
  runs: NodeRun[],
  patch: { providerSessionRef?: string; outputOffset?: number },
): NodeRun[] {
  const open = getOpenRun(runs);
  if (!open) throw new Error("no open run to patch");

  const realIndex = runs.indexOf(open);
  const patched: NodeRun = { ...open, ...patch };
  return [...runs.slice(0, realIndex), patched, ...runs.slice(realIndex + 1)];
}
