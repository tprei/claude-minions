import { describe, expect, it } from "vitest";
import { LocalFinalizeService } from "../../src/application/local-finalize-service.js";
import { applyCommand } from "../../src/application/commands.js";
import { InMemoryWorkflowRepository } from "../../src/application/repository.js";
import { createWorkflow } from "../../src/domain/workflow.js";
import { transitionTask } from "../../src/application/transitions.js";
import { DomainError } from "../../src/domain/errors.js";
import { silentLogger } from "../test-helpers.js";

const NOW = "2026-05-10T00:00:00.000Z";
const now = () => NOW;
const WORKFLOW_ID = "wf-local";
const TASK_ID = "wf-local:task";

async function makeWorkflowInFinalizing(repo: InMemoryWorkflowRepository): Promise<void> {
  const wf = createWorkflow({
    id: WORKFLOW_ID,
    kind: "single-task",
    tasks: [{ id: TASK_ID, title: "T", prompt: "P" }],
  }, now);
  await repo.save(wf, []);
  await applyCommand(repo, {
    kind: "transition-task",
    workflowId: WORKFLOW_ID,
    transition: { kind: "mark-ready", taskId: TASK_ID, now: NOW },
  });
  await applyCommand(repo, {
    kind: "transition-task",
    workflowId: WORKFLOW_ID,
    transition: { kind: "mark-running", taskId: TASK_ID, sessionId: "s1", now: NOW },
  });
  await applyCommand(repo, {
    kind: "transition-task",
    workflowId: WORKFLOW_ID,
    transition: { kind: "complete-runtime", taskId: TASK_ID, now: NOW },
  });
  await applyCommand(repo, {
    kind: "transition-task",
    workflowId: WORKFLOW_ID,
    transition: { kind: "start-finalization", taskId: TASK_ID, now: NOW },
  });
}

describe("complete-without-pr transition", () => {
  it("transitions a task from finalizing to merged", () => {
    let wf = createWorkflow({
      id: WORKFLOW_ID,
      kind: "single-task",
      tasks: [{ id: TASK_ID, title: "T", prompt: "P" }],
    }, now);

    wf = transitionTask(wf, { kind: "mark-ready", taskId: TASK_ID, now: NOW });
    wf = transitionTask(wf, { kind: "mark-running", taskId: TASK_ID, sessionId: "s1", now: NOW });
    wf = transitionTask(wf, { kind: "complete-runtime", taskId: TASK_ID, now: NOW });
    wf = transitionTask(wf, { kind: "start-finalization", taskId: TASK_ID, now: NOW });

    expect(wf.graph[TASK_ID]?.executionStatus).toBe("finalizing");

    wf = transitionTask(wf, { kind: "complete-without-pr", taskId: TASK_ID, now: NOW });

    expect(wf.graph[TASK_ID]?.executionStatus).toBe("merged");
    expect(wf.status).toBe("completed");
  });

  it("rejects complete-without-pr from non-finalizing states", () => {
    let wf = createWorkflow({
      id: WORKFLOW_ID,
      kind: "single-task",
      tasks: [{ id: TASK_ID, title: "T", prompt: "P" }],
    }, now);
    wf = transitionTask(wf, { kind: "mark-ready", taskId: TASK_ID, now: NOW });

    expect(() =>
      transitionTask(wf, { kind: "complete-without-pr", taskId: TASK_ID, now: NOW }),
    ).toThrow(DomainError);
  });
});

describe("LocalFinalizeService", () => {
  it("auto-transitions a task in finalizing to merged on attach", async () => {
    const repo = new InMemoryWorkflowRepository();
    await makeWorkflowInFinalizing(repo);

    const ctrl = new AbortController();
    const svc = new LocalFinalizeService({
      workflowRepo: repo,
      applyCommand: (cmd) => applyCommand(repo, cmd),
      signal: ctrl.signal,
      now,
      log: silentLogger(),
    });

    svc.attach(WORKFLOW_ID);

    // Give the async flow a chance to run
    await new Promise<void>((r) => setTimeout(r, 20));

    const wf = await repo.get(WORKFLOW_ID);
    expect(wf?.graph[TASK_ID]?.executionStatus).toBe("merged");
    ctrl.abort();
  });

  it("auto-transitions when a task transitions to finalizing via event", async () => {
    const repo = new InMemoryWorkflowRepository();
    const wf = createWorkflow({
      id: WORKFLOW_ID,
      kind: "single-task",
      tasks: [{ id: TASK_ID, title: "T", prompt: "P" }],
    }, now);
    await repo.save(wf, []);
    await applyCommand(repo, {
      kind: "transition-task",
      workflowId: WORKFLOW_ID,
      transition: { kind: "mark-ready", taskId: TASK_ID, now: NOW },
    });
    await applyCommand(repo, {
      kind: "transition-task",
      workflowId: WORKFLOW_ID,
      transition: { kind: "mark-running", taskId: TASK_ID, sessionId: "s1", now: NOW },
    });

    const ctrl = new AbortController();
    const svc = new LocalFinalizeService({
      workflowRepo: repo,
      applyCommand: (cmd) => applyCommand(repo, cmd),
      signal: ctrl.signal,
      now,
      log: silentLogger(),
    });

    svc.attach(WORKFLOW_ID);
    // Give attach to initialize
    await new Promise<void>((r) => setTimeout(r, 5));

    // Now complete runtime + start finalization (triggers event consumer)
    await applyCommand(repo, {
      kind: "transition-task",
      workflowId: WORKFLOW_ID,
      transition: { kind: "complete-runtime", taskId: TASK_ID, now: NOW },
    });
    await applyCommand(repo, {
      kind: "transition-task",
      workflowId: WORKFLOW_ID,
      transition: { kind: "start-finalization", taskId: TASK_ID, now: NOW },
    });

    await new Promise<void>((r) => setTimeout(r, 20));

    const result = await repo.get(WORKFLOW_ID);
    expect(result?.graph[TASK_ID]?.executionStatus).toBe("merged");
    ctrl.abort();
  });
});
