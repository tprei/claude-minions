import type {
  ResourceSnapshot,
  RuntimeOverrides,
  SessionMode,
} from "@minions/shared";

export type SessionClass =
  | "interactive"
  | "autonomous_loop"
  | "dag_task"
  | "background";

export const SESSION_CLASSES: readonly SessionClass[] = [
  "interactive",
  "autonomous_loop",
  "dag_task",
  "background",
] as const;

export type RunningByClass = Record<SessionClass, number>;

export interface AdmissionLimits {
  totalSlots: number;
  reservedInteractive: number;
  loopCap: number;
  dagCap: number;
  backgroundCap: number;
}

export interface ResourceFloors {
  diskFloorBytes: number;
  memoryFloorBytes: number;
  eventLoopLagCeilingMs: number;
  maxClaudeProcesses: number;
}

export type AdmissionDecision =
  | { admit: true }
  | { admit: false; reason: string };

const DEFAULTS: AdmissionLimits = {
  totalSlots: 8,
  reservedInteractive: 2,
  loopCap: 4,
  dagCap: 4,
  backgroundCap: 2,
};

const RESOURCE_FLOOR_DEFAULTS: ResourceFloors = {
  diskFloorBytes: 5_000_000_000,
  memoryFloorBytes: 1_000_000_000,
  eventLoopLagCeilingMs: 250,
  maxClaudeProcesses: 12,
};

export function classifyMode(mode: SessionMode): SessionClass {
  switch (mode) {
    case "task":
      return "interactive";
    case "ship":
      return "interactive";
    case "loop":
      return "autonomous_loop";
    case "dag-task":
      return "dag_task";
    default:
      return "background";
  }
}

export function emptyRunningByClass(): RunningByClass {
  return {
    interactive: 0,
    autonomous_loop: 0,
    dag_task: 0,
    background: 0,
  };
}

function readNumber(runtime: RuntimeOverrides, key: string, fallback: number): number {
  const v = runtime[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

export function resolveAdmissionLimits(runtime: RuntimeOverrides): AdmissionLimits {
  return {
    totalSlots: readNumber(runtime, "admissionTotalSlots", DEFAULTS.totalSlots),
    reservedInteractive: readNumber(runtime, "admissionReservedInteractive", DEFAULTS.reservedInteractive),
    loopCap: readNumber(runtime, "admissionLoopCap", DEFAULTS.loopCap),
    dagCap: readNumber(runtime, "admissionDagCap", DEFAULTS.dagCap),
    backgroundCap: readNumber(runtime, "admissionBackgroundCap", DEFAULTS.backgroundCap),
  };
}

export function isAdmissionUnlimited(runtime: RuntimeOverrides): boolean {
  return runtime["admissionUnlimited"] === true;
}

export function resolveResourceFloors(runtime: RuntimeOverrides): ResourceFloors {
  return {
    diskFloorBytes: readNumber(
      runtime,
      "admissionDiskFloorBytes",
      RESOURCE_FLOOR_DEFAULTS.diskFloorBytes,
    ),
    memoryFloorBytes: readNumber(
      runtime,
      "admissionMemoryFloorBytes",
      RESOURCE_FLOOR_DEFAULTS.memoryFloorBytes,
    ),
    eventLoopLagCeilingMs: readNumber(
      runtime,
      "admissionEventLoopLagCeilingMs",
      RESOURCE_FLOOR_DEFAULTS.eventLoopLagCeilingMs,
    ),
    maxClaudeProcesses: readNumber(
      runtime,
      "admissionMaxClaudeProcesses",
      RESOURCE_FLOOR_DEFAULTS.maxClaudeProcesses,
    ),
  };
}

export function checkResourceFloor(
  runtime: RuntimeOverrides,
  sample: ResourceSnapshot | null,
): AdmissionDecision {
  if (!sample) return { admit: true };
  const floors = resolveResourceFloors(runtime);

  const freeDisk = Math.max(0, sample.disk.totalBytes - sample.disk.usedBytes);
  if (sample.disk.totalBytes > 0 && freeDisk < floors.diskFloorBytes) {
    return {
      admit: false,
      reason: `resource:disk free ${freeDisk} below floor ${floors.diskFloorBytes}`,
    };
  }

  const freeMemory = Math.max(0, sample.memory.limitBytes - sample.memory.usedBytes);
  if (sample.memory.limitBytes > 0 && freeMemory < floors.memoryFloorBytes) {
    return {
      admit: false,
      reason: `resource:memory free ${freeMemory} below floor ${floors.memoryFloorBytes}`,
    };
  }

  if (sample.eventLoop.lagMs > floors.eventLoopLagCeilingMs) {
    return {
      admit: false,
      reason: `resource:lag ${sample.eventLoop.lagMs.toFixed(1)}ms above ceiling ${floors.eventLoopLagCeilingMs}ms`,
    };
  }

  if (sample.sessions.running > floors.maxClaudeProcesses) {
    return {
      admit: false,
      reason: `resource:processes running ${sample.sessions.running} above max ${floors.maxClaudeProcesses}`,
    };
  }

  return { admit: true };
}

export function checkAdmission(
  cls: SessionClass,
  runningByClass: RunningByClass,
  runtime: RuntimeOverrides,
  sample: ResourceSnapshot | null = null,
): AdmissionDecision {
  const resourceDecision = checkResourceFloor(runtime, sample);
  if (!resourceDecision.admit) return resourceDecision;
  if (isAdmissionUnlimited(runtime)) {
    return { admit: true };
  }
  const limits = resolveAdmissionLimits(runtime);
  const total =
    runningByClass.interactive +
    runningByClass.autonomous_loop +
    runningByClass.dag_task +
    runningByClass.background;
  const nonInteractive = total - runningByClass.interactive;
  const nonInteractiveBudget = Math.max(0, limits.totalSlots - limits.reservedInteractive);

  if (cls === "interactive") {
    if (total >= limits.totalSlots) {
      return {
        admit: false,
        reason: `total sessions ${total} at totalSlots ${limits.totalSlots}`,
      };
    }
    return { admit: true };
  }

  if (nonInteractive >= nonInteractiveBudget) {
    return {
      admit: false,
      reason: `non-interactive sessions ${nonInteractive} at budget ${nonInteractiveBudget} (totalSlots ${limits.totalSlots} - reservedInteractive ${limits.reservedInteractive})`,
    };
  }

  if (cls === "autonomous_loop") {
    if (runningByClass.autonomous_loop >= limits.loopCap) {
      return {
        admit: false,
        reason: `autonomous_loop ${runningByClass.autonomous_loop} at loopCap ${limits.loopCap}`,
      };
    }
    return { admit: true };
  }

  if (cls === "dag_task") {
    if (runningByClass.dag_task >= limits.dagCap) {
      return {
        admit: false,
        reason: `dag_task ${runningByClass.dag_task} at dagCap ${limits.dagCap}`,
      };
    }
    return { admit: true };
  }

  if (runningByClass.background >= limits.backgroundCap) {
    return {
      admit: false,
      reason: `background ${runningByClass.background} at backgroundCap ${limits.backgroundCap}`,
    };
  }
  return { admit: true };
}
