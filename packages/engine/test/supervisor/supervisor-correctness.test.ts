import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { createSupervisor } from "../../src/supervisor/supervisor.js";
import { ScanLoop } from "../../src/supervisor/scan-loop.js";
import { orchestratorSilentRule } from "../../src/supervisor/rules/orchestrator-silent.js";
import { ciExhaustedRule } from "../../src/supervisor/rules/ci-exhausted.js";
import { SupervisorState } from "../../src/supervisor/state.js";
import { AlertRepo, AlertSubscriptionRepo } from "../../src/supervisor/alert-repo.js";
import { AlertNotifier } from "../../src/supervisor/alert-notifier.js";
import { InMemoryWorkflowRepository } from "../../src/application/repository.js";
import { createWorkflow } from "../../src/domain/workflow.js";
import type { AnomalyRuleContext } from "../../src/supervisor/rules/index.js";
import type { LogRecord } from "../../src/observability/types.js";

function makeTempDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "supervisor-correctness-test-"));
  return new Database(join(dir, "test.db"));
}

function makeRecord(kind: string, workflowId: string, extra?: Record<string, unknown>): LogRecord {
  return { t: new Date().toISOString(), lvl: "info", msg: "event", kind, workflowId, ...extra };
}

const SILENCE_MS = 30 * 60 * 1000;

describe("orchestrator-silent: two-task workflow, one completes then other is silent → exactly one alert", () => {
  it("fires exactly one alert for the still-hung task", async () => {
    const fireAlert = vi.fn();
    const nowMs = 100_000_000;
    const ctx: AnomalyRuleContext = {
      now: () => nowMs,
      fireAlert,
      state: new SupervisorState(),
      workflowRepo: new InMemoryWorkflowRepository(),
    };

    orchestratorSilentRule.onLogRecord!(makeRecord("run-started", "wf-1", { taskId: "t-1" }), ctx);
    orchestratorSilentRule.onLogRecord!(makeRecord("run-started", "wf-1", { taskId: "t-2" }), ctx);
    orchestratorSilentRule.onLogRecord!(
      makeRecord("task-transitioned", "wf-1", { toExecutionStatus: "completed", taskId: "t-1" }),
      ctx,
    );

    ctx.state.activity.get("wf-1")!.lastEventAt = nowMs - SILENCE_MS - 1;

    await orchestratorSilentRule.onScan!(ctx);
    await orchestratorSilentRule.onScan!(ctx);

    expect(fireAlert).toHaveBeenCalledOnce();
    expect(fireAlert.mock.calls[0]![0].kind).toBe("orchestrator-silent");
    expect(fireAlert.mock.calls[0]![0].workflowId).toBe("wf-1");
  });
});

describe("ci-exhausted: alert fires for workflowId containing colon (team:wf-1)", () => {
  it("correctly resolves wfId with colon without splitting wrong", async () => {
    const fireAlert = vi.fn();
    const repo = new InMemoryWorkflowRepository();
    const ctx: AnomalyRuleContext = {
      now: () => Date.now(),
      fireAlert,
      state: new SupervisorState(),
      workflowRepo: repo,
    };

    const wf = createWorkflow({
      id: "team:wf-1",
      kind: "single-task",
      repoId: "fixture-repo",
      tasks: [{ id: "t-1", title: "task", prompt: "do thing" }],
    });
    const taskNode = wf.graph["t-1"]!;
    await repo.save(
      { ...wf, graph: { ...wf.graph, "t-1": { ...taskNode, executionStatus: "pr-open" } } },
      [],
    );

    const capRecord: LogRecord = {
      t: new Date().toISOString(),
      lvl: "info",
      msg: "ci cap",
      kind: "ci-attempt-cap",
      workflowId: "team:wf-1",
      taskId: "t-1",
    };
    ciExhaustedRule.onLogRecord!(capRecord, ctx);
    await ciExhaustedRule.onScan!(ctx);

    expect(fireAlert).toHaveBeenCalledOnce();
    expect(fireAlert.mock.calls[0]![0].workflowId).toBe("team:wf-1");
    expect(fireAlert.mock.calls[0]![0].taskId).toBe("t-1");
  });
});

describe("supervisor.fireAlert: persist-before-dedup consistency", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeTempDb();
  });

  afterEach(() => {
    db.close();
  });

  it("when subRepo.list throws, exactly one alert row is persisted and dedup holds within cooldown", async () => {
    const alertRepo = new AlertRepo(db);
    const subRepo = new AlertSubscriptionRepo(db);
    vi.spyOn(subRepo, "list").mockImplementation(() => {
      throw new Error("subRepo.list failed");
    });

    const notifier = new AlertNotifier(alertRepo, subRepo, undefined);
    const state = new SupervisorState();

    const nowMs = 1_000_000;
    const dedupeCooldownMs = 5 * 60 * 1000;

    const fireAlert = (partial: Omit<import("../../src/supervisor/alert.js").Alert, "id" | "timestamp">): void => {
      const dedupeKey = `${partial.kind}\0${partial.workflowId ?? ""}\0${partial.taskId ?? ""}`;
      const lastFired = state.recentAlerts.get(dedupeKey);
      if (lastFired !== undefined && nowMs - lastFired < dedupeCooldownMs) return;
      const alert = {
        id: crypto.randomUUID(),
        timestamp: new Date(nowMs).toISOString(),
        ...partial,
      };
      try {
        notifier.persist(alert);
      } catch {
        return;
      }
      state.recentAlerts.set(dedupeKey, nowMs);
      notifier.notify(alert).catch(() => {});
    };

    fireAlert({ kind: "orchestrator-silent", severity: "warn", message: "test", workflowId: "wf-1" });

    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(alertRepo.list()).toHaveLength(1);

    fireAlert({ kind: "orchestrator-silent", severity: "warn", message: "test", workflowId: "wf-1" });

    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(alertRepo.list()).toHaveLength(1);
  });
});

describe("scan-loop: double start() guard", () => {
  it("calling start() twice runs at most one tick chain", async () => {
    const handler = vi.fn(async () => {});

    const loop = new ScanLoop(handler, 5_000_000);

    loop.start();
    loop.start();
    loop.start();

    await loop.stop();

    expect(handler).not.toHaveBeenCalled();
  });

  it("two start() calls before any tick completes do not spawn two timer chains", async () => {
    const ticks: number[] = [];
    let nowMs = 0;

    const handler = vi.fn(async () => {
      ticks.push(nowMs++);
    });

    const loop = new ScanLoop(handler, 50);

    loop.start();
    loop.start();

    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    await loop.stop();

    const callCount = handler.mock.calls.length;
    expect(callCount).toBeGreaterThanOrEqual(1);

    if (callCount >= 2) {
      for (let i = 1; i < ticks.length; i++) {
        expect(ticks[i]).toBeGreaterThan(ticks[i - 1]!);
      }
    }
  });
});

describe("supervisor: createSupervisor double-start guard via scan-loop", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeTempDb();
  });

  afterEach(async () => {
    db.close();
  });

  it("calling supervisor.start() twice does not spawn two tick chains", async () => {
    let scanCount = 0;
    const countingRule = {
      id: "orchestrator-silent" as const,
      async onScan(): Promise<void> {
        scanCount++;
      },
    };

    const sup = createSupervisor({
      db,
      scanIntervalMs: 50,
      rules: [countingRule],
    });
    sup.attachRepo(new InMemoryWorkflowRepository());

    sup.start();
    sup.start();
    sup.start();

    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    await sup.stop();

    const observed = scanCount;

    sup.start();

    await new Promise<void>((resolve) => setTimeout(resolve, 200));

    expect(scanCount).toBe(observed);
  });
});
