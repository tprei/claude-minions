import type { RuntimeBackend } from "../plugins/runtime-backend.js";
import type { RuntimeProbeState } from "./recovery.js";
import type { RecoveryService } from "./recovery-service.js";
import type { WorkflowRepository } from "./repository.js";
import { getOpenRun } from "../domain/runs.js";

export interface BootRespawnContext {
  workflowId: string;
  taskId: string;
  runId: string;
  runtimeSessionId: string;
  providerType: string;
  runtimeType: string;
  workspaceId?: string;
  /**
   * Last persisted output offset. May be undefined when the prior orchestrator
   * died mid-run before flushing offset (slice 10 only writes on final/interrupt).
   * Resume in that case starts at byte 0; provider parsers are stateless per-line
   * so duplicate events are harmless (closed-run state guards reject duplicate dispatches).
   */
  fromOffset?: number;
}

export interface BootRecoveryOptions {
  now: () => string;
  staleReadyMs: number;
  staleGateMs: number;
  spawnOrchestrator?: (ctx: BootRespawnContext) => void;
}

export interface BootRecoveryFailure {
  workflowId: string;
  phase: "probe" | "scan" | "spawn";
  error: string;
}

export interface BootRecoveryReport {
  workflowsScanned: number;
  orchestratorsSpawned: number;
  failures: BootRecoveryFailure[];
}

export async function runBootRecovery(
  repo: WorkflowRepository,
  recoveryService: RecoveryService,
  runtime: RuntimeBackend,
  options: BootRecoveryOptions,
): Promise<BootRecoveryReport> {
  const workflows = await repo.listRecoverable();
  const report: BootRecoveryReport = { workflowsScanned: 0, orchestratorsSpawned: 0, failures: [] };

  for (const workflow of workflows) {
    const runtimeProbes: Record<string, RuntimeProbeState> = {};
    let probeFailed = false;

    for (const task of Object.values(workflow.graph)) {
      if (!task.sessionId) continue;
      try {
        runtimeProbes[task.sessionId] = await runtime.probe(task.sessionId);
      } catch (err) {
        report.failures.push({
          workflowId: workflow.id,
          phase: "probe",
          error: err instanceof Error ? err.message : String(err),
        });
        probeFailed = true;
        break;
      }
    }

    if (probeFailed) continue;

    try {
      await recoveryService.scan(workflow.id, {
        nowMs: Date.parse(options.now()),
        staleReadyMs: options.staleReadyMs,
        staleGateMs: options.staleGateMs,
        runtimeProbes,
        workflowCancelled: workflow.status === "cancelled",
      });
      report.workflowsScanned += 1;
    } catch (err) {
      report.failures.push({
        workflowId: workflow.id,
        phase: "scan",
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    if (options.spawnOrchestrator) {
      let postScanWorkflow: Awaited<ReturnType<typeof repo.get>>;
      try {
        postScanWorkflow = await repo.get(workflow.id);
      } catch (err) {
        report.failures.push({
          workflowId: workflow.id,
          phase: "spawn",
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      if (!postScanWorkflow) continue;

      for (const task of Object.values(postScanWorkflow.graph)) {
        if (task.executionStatus !== "running") continue;
        if (!task.sessionId) continue;
        if (runtimeProbes[task.sessionId] !== "live") continue;

        const openRun = getOpenRun(task.runs);
        if (!openRun) {
          report.failures.push({
            workflowId: workflow.id,
            phase: "spawn",
            error: `no open run for live task ${task.id}`,
          });
          continue;
        }

        const ctx: BootRespawnContext = {
          workflowId: workflow.id,
          taskId: task.id,
          runId: openRun.id,
          runtimeSessionId: task.sessionId,
          providerType: openRun.providerType,
          runtimeType: openRun.runtimeType,
        };
        if (task.workspaceId !== undefined) ctx.workspaceId = task.workspaceId;
        // skip stored offset when sessionRef hasn't been captured — preserves provider-state-init events at offset 0
        if (openRun.outputOffset !== undefined && openRun.providerSessionRef !== undefined) {
          ctx.fromOffset = openRun.outputOffset;
        }

        try {
          options.spawnOrchestrator(ctx);
          report.orchestratorsSpawned += 1;
        } catch (err) {
          report.failures.push({
            workflowId: workflow.id,
            phase: "spawn",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  return report;
}
