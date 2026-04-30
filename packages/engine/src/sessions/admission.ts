import type { RuntimeOverrides, SessionMode } from "@minions/shared";

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
  return runtime.admissionUnlimited === true;
}

export function checkAdmission(
  cls: SessionClass,
  runningByClass: RunningByClass,
  runtime: RuntimeOverrides,
): AdmissionDecision {
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
