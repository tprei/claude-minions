import { describe, expect, it, vi } from "vitest";
import { RunOrchestrator } from "../../src/application/run-orchestrator.js";
import { silentLogger } from "../test-helpers.js";
import { DomainError } from "../../src/domain/errors.js";
import type { Command, CommandResult } from "../../src/application/commands.js";
import type { RuntimeBackend, RuntimeAttachOptions, RuntimeOutputChunk } from "../../src/plugins/runtime-backend.js";
import { StubProviderPlugin } from "../../src/plugins/providers/stub.js";
import { StubWorkspaceBackend } from "../../src/plugins/workspace/stub-workspace.js";
import { createSingleTaskWorkflow } from "../../src/domain/workflow.js";
import type { ProviderEvent } from "../../src/plugins/provider-plugin.js";
import type { RuntimeProbeState } from "../../src/application/recovery.js";

const now = "2026-05-04T11:19:00.000Z";

function makeCommandResult(): CommandResult {
  return { workflow: createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now), events: [] };
}

function makeChunks(lines: string[], startOffset: number = 0): RuntimeOutputChunk[] {
  const chunks: RuntimeOutputChunk[] = [];
  let offset = startOffset;
  for (const line of lines) {
    const bytes = new TextEncoder().encode(line + "\n");
    chunks.push({ sessionId: "session-1", offset, bytes });
    offset += bytes.byteLength;
  }
  return chunks;
}

function makeRuntime(chunks: RuntimeOutputChunk[], shouldThrow?: Error): RuntimeBackend {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    probe: vi.fn().mockResolvedValue("live" as RuntimeProbeState),
    attach(_sessionId: string, _opts?: RuntimeAttachOptions): AsyncIterable<RuntimeOutputChunk> {
      return {
        [Symbol.asyncIterator]: async function* () {
          for (const chunk of chunks) {
            yield chunk;
          }
          if (shouldThrow) throw shouldThrow;
        },
      };
    },
  };
}

function makeOrchestrator(
  providerFrames: ProviderEvent[][],
  chunks: RuntimeOutputChunk[],
  applyCommand: (cmd: Command) => Promise<CommandResult>,
  shouldThrow?: Error,
  publish?: (event: ProviderEvent) => void,
) {
  const provider = new StubProviderPlugin({ frames: providerFrames });
  const runtime = makeRuntime(chunks, shouldThrow);

  return new RunOrchestrator({
    workflowId: "wf-1",
    taskId: "task-1",
    runId: "run-1",
    runtimeSessionId: "session-1",
    provider,
    runtime,
    workspace: new StubWorkspaceBackend(),
    workspaceId: "stub-wf1_task1",
    applyCommand,
    publish: publish ?? (() => {}),
    now: () => now,
    log: silentLogger(),
  });
}

describe("RunOrchestrator", () => {
  it("happy path: offset from earlier chunk + final with sessionRef → update-run then complete-runtime in order", async () => {
    const calls: string[] = [];
    const applyCommand = vi.fn(async (cmd: Command): Promise<CommandResult> => {
      if (cmd.kind === "transition-task") calls.push(cmd.transition.kind);
      return makeCommandResult();
    });

    const assistantEvent: ProviderEvent = { kind: "assistant_text", text: "hello" };
    const finalEvent: ProviderEvent = { kind: "final", sessionRef: "abc-ref" };
    const chunks = makeChunks(["line-1", "line-2"], 0);

    const orchestrator = makeOrchestrator([[assistantEvent], [finalEvent]], chunks, applyCommand);
    await orchestrator.run();

    expect(calls).toEqual(["update-run", "complete-runtime"]);

    const updateCall = applyCommand.mock.calls.find(
      ([cmd]) => cmd.kind === "transition-task" && cmd.transition.kind === "update-run",
    );
    expect(updateCall).toBeDefined();
    const t = (updateCall![0] as Extract<Command, { kind: "transition-task" }>).transition;
    expect(t.providerSessionRef).toBe("abc-ref");
    // outputOffset must NOT be written on the success path — prevents offset-after-final race
    expect(t.outputOffset).toBeUndefined();
  });

  it("stream throws mid-iteration → best-effort update-run with offset then mark-interrupted", async () => {
    const calls: string[] = [];
    const applyCommand = vi.fn(async (cmd: Command): Promise<CommandResult> => {
      if (cmd.kind === "transition-task") calls.push(cmd.transition.kind);
      return makeCommandResult();
    });

    const chunks = makeChunks(["line-1"], 0);
    const orchestrator = makeOrchestrator([], chunks, applyCommand, new Error("stream exploded"));
    await orchestrator.run();

    expect(calls).toEqual(["update-run", "mark-interrupted"]);

    const updateCall = applyCommand.mock.calls.find(
      ([cmd]) => cmd.kind === "transition-task" && cmd.transition.kind === "update-run",
    );
    const t = (updateCall![0] as Extract<Command, { kind: "transition-task" }>).transition;
    expect(typeof t.outputOffset).toBe("number");
  });

  it("empty final.sessionRef with no prior sessionRef → no update-run dispatched, complete-runtime fires", async () => {
    const calls: string[] = [];
    const applyCommand = vi.fn(async (cmd: Command): Promise<CommandResult> => {
      if (cmd.kind === "transition-task") calls.push(cmd.transition.kind);
      return makeCommandResult();
    });

    const assistantEvent: ProviderEvent = { kind: "assistant_text", text: "hi" };
    const finalEvent: ProviderEvent = { kind: "final", sessionRef: "" };
    const chunks = makeChunks(["line-1", "line-2"], 0);

    const orchestrator = makeOrchestrator([[assistantEvent], [finalEvent]], chunks, applyCommand);
    await orchestrator.run();

    expect(calls).toEqual(["complete-runtime"]);
  });

  it("stream completes without final and without offset → mark-interrupted only, no update-run", async () => {
    const calls: string[] = [];
    const applyCommand = vi.fn(async (cmd: Command): Promise<CommandResult> => {
      if (cmd.kind === "transition-task") calls.push(cmd.transition.kind);
      return makeCommandResult();
    });

    const orchestrator = makeOrchestrator([], [], applyCommand);
    await orchestrator.run();

    expect(calls).toEqual(["mark-interrupted"]);
  });

  it("update-run rejects with version_conflict → orchestrator continues to complete-runtime", async () => {
    const calls: string[] = [];
    const applyCommand = vi.fn(async (cmd: Command): Promise<CommandResult> => {
      if (cmd.kind === "transition-task") {
        calls.push(cmd.transition.kind);
        if (cmd.transition.kind === "update-run") {
          throw new DomainError("version_conflict", "conflict", { taskId: "task-1" });
        }
      }
      return makeCommandResult();
    });

    const assistantEvent: ProviderEvent = { kind: "assistant_text", text: "hi" };
    const finalEvent: ProviderEvent = { kind: "final", sessionRef: "ref-x" };
    const chunks = makeChunks(["line-1", "line-2"], 0);

    const orchestrator = makeOrchestrator([[assistantEvent], [finalEvent]], chunks, applyCommand);
    await orchestrator.run();

    expect(calls).toEqual(["update-run", "complete-runtime"]);
  });

  it("stale session: session_mismatch on complete-runtime → exits silently without rethrowing", async () => {
    const calls: string[] = [];
    const applyCommand = vi.fn(async (cmd: Command): Promise<CommandResult> => {
      if (cmd.kind === "transition-task") {
        calls.push(cmd.transition.kind);
        if (cmd.transition.kind === "complete-runtime") {
          throw new DomainError("session_mismatch", "task session does not match", { taskId: "task-1" });
        }
      }
      return makeCommandResult();
    });

    const finalEvent: ProviderEvent = { kind: "final", sessionRef: "ref-x" };
    const chunks = makeChunks(["line-1"], 0);

    const orchestrator = makeOrchestrator([[finalEvent]], chunks, applyCommand);
    await expect(orchestrator.run()).resolves.toBeUndefined();
    expect(calls).toContain("complete-runtime");
    expect(calls).not.toContain("mark-interrupted");
  });

  it("provider error{recoverable:false} then final → update-run then mark-interrupted, not complete-runtime", async () => {
    const calls: string[] = [];
    const applyCommand = vi.fn(async (cmd: Command): Promise<CommandResult> => {
      if (cmd.kind === "transition-task") calls.push(cmd.transition.kind);
      return makeCommandResult();
    });

    const errorEvent: ProviderEvent = { kind: "error", recoverable: false, message: "turn failed" };
    const finalEvent: ProviderEvent = { kind: "final", sessionRef: "ref-x" };
    const chunks = makeChunks(["line-1", "line-2"], 0);

    const orchestrator = makeOrchestrator([[errorEvent], [finalEvent]], chunks, applyCommand);
    await orchestrator.run();

    expect(calls).toEqual(["update-run", "mark-interrupted"]);
    expect(calls).not.toContain("complete-runtime");
  });

  it("threads fromOffset from deps to runtime.attach", async () => {
    let capturedAttachOpts: RuntimeAttachOptions | undefined;
    const runtime: RuntimeBackend = {
      start: vi.fn(),
      stop: vi.fn(),
      probe: vi.fn().mockResolvedValue("live" as RuntimeProbeState),
      attach(_sessionId: string, opts?: RuntimeAttachOptions): AsyncIterable<RuntimeOutputChunk> {
        capturedAttachOpts = opts;
        return { [Symbol.asyncIterator]: async function* () {} };
      },
    };

    const provider = new StubProviderPlugin({ frames: [] });
    const applyCommand = vi.fn(async (_cmd: Command): Promise<CommandResult> => makeCommandResult());

    const orch = new RunOrchestrator({
      workflowId: "wf-1",
      taskId: "task-1",
      runId: "run-1",
      runtimeSessionId: "session-1",
      provider,
      runtime,
      workspace: new StubWorkspaceBackend(),
      workspaceId: "stub-wf1_task1",
      applyCommand,
      publish: () => {},
      now: () => now,
      fromOffset: 42,
      log: silentLogger(),
    });
    await orch.run();

    expect(capturedAttachOpts?.fromOffset).toBe(42);
  });

  it("complete-runtime crash: success-path update-run carried only providerSessionRef (no outputOffset)", async () => {
    // Simulates: crash between update-run and complete-runtime on the success path.
    // On re-spawn the orchestrator replays from the prior (un-advanced) offset and
    // re-emits final, so the run eventually closes correctly.
    const updateRunTransitions: Array<Record<string, unknown>> = [];
    const calls: string[] = [];
    const applyCommand = vi.fn(async (cmd: Command): Promise<CommandResult> => {
      if (cmd.kind === "transition-task") {
        calls.push(cmd.transition.kind);
        if (cmd.transition.kind === "update-run") {
          updateRunTransitions.push(cmd.transition as unknown as Record<string, unknown>);
          return makeCommandResult();
        }
        if (cmd.transition.kind === "complete-runtime") {
          throw new Error("simulated crash before complete-runtime persisted");
        }
      }
      return makeCommandResult();
    });

    const finalEvent: ProviderEvent = { kind: "final", sessionRef: "abc" };
    const chunks = makeChunks(["line-1", "line-2"], 50);

    const orchestrator = makeOrchestrator([[finalEvent]], chunks, applyCommand);
    // complete-runtime throw is caught by the outer catch → orchestrator calls mark-interrupted
    await orchestrator.run();

    // The success-path update-run must have carried providerSessionRef but NOT outputOffset
    const successPathPatch = updateRunTransitions.find((t) => t["providerSessionRef"] === "abc");
    expect(successPathPatch).toBeDefined();
    expect(successPathPatch!["outputOffset"]).toBeUndefined();
  });

  it("aborted signal: orchestrator exits without dispatching mark-interrupted, leaving task running", async () => {
    const applyCommand = vi.fn(async (_cmd: Command): Promise<CommandResult> => makeCommandResult());

    const controller = new AbortController();
    controller.abort();

    const runtime: RuntimeBackend = {
      start: vi.fn(),
      stop: vi.fn(),
      probe: vi.fn().mockResolvedValue("live" as RuntimeProbeState),
      attach(_sessionId: string, _opts?: RuntimeAttachOptions): AsyncIterable<RuntimeOutputChunk> {
        return { [Symbol.asyncIterator]: async function* () {} };
      },
    };

    const provider = new StubProviderPlugin({ frames: [] });
    const orch = new RunOrchestrator({
      workflowId: "wf-1",
      taskId: "task-1",
      runId: "run-1",
      runtimeSessionId: "session-1",
      provider,
      runtime,
      workspace: new StubWorkspaceBackend(),
      workspaceId: "stub-wf1_task1",
      applyCommand,
      publish: () => {},
      now: () => now,
      signal: controller.signal,
      log: silentLogger(),
    });

    await orch.run();

    expect(applyCommand).not.toHaveBeenCalled();
  });

  it("complete-runtime crash after final does not advance outputOffset", async () => {
    const updateRunTransitions: Array<Record<string, unknown>> = [];
    const calls: string[] = [];
    const applyCommand = vi.fn(async (cmd: Command): Promise<CommandResult> => {
      if (cmd.kind === "transition-task") {
        calls.push(cmd.transition.kind);
        if (cmd.transition.kind === "update-run") {
          const t = cmd.transition as unknown as Record<string, unknown>;
          updateRunTransitions.push(t);
          if (t["outputOffset"] !== undefined) {
            throw new Error("unexpected catch-path offset write");
          }
          return makeCommandResult();
        }
        if (cmd.transition.kind === "complete-runtime") {
          throw new Error("simulated complete-runtime failure");
        }
      }
      return makeCommandResult();
    });

    const finalEvent: ProviderEvent = { kind: "final", sessionRef: "abc" };
    const chunks = makeChunks(["line-1", "line-2"], 50);

    const orchestrator = makeOrchestrator([[finalEvent]], chunks, applyCommand);
    await orchestrator.run();

    const offsetWrite = updateRunTransitions.find((t) => t["outputOffset"] !== undefined);
    expect(offsetWrite).toBeUndefined();
    expect(calls).toContain("mark-interrupted");
  });

  it("failure path (stream throws): update-run writes outputOffset for resume, then mark-interrupted", async () => {
    const updateRunTransitions: Array<Record<string, unknown>> = [];
    const calls: string[] = [];
    const applyCommand = vi.fn(async (cmd: Command): Promise<CommandResult> => {
      if (cmd.kind === "transition-task") {
        calls.push(cmd.transition.kind);
        if (cmd.transition.kind === "update-run") {
          updateRunTransitions.push(cmd.transition as unknown as Record<string, unknown>);
        }
      }
      return makeCommandResult();
    });

    const chunks = makeChunks(["line-1"], 0);
    const orchestrator = makeOrchestrator([], chunks, applyCommand, new Error("stream exploded"));
    await orchestrator.run();

    expect(calls).toEqual(["update-run", "mark-interrupted"]);
    expect(updateRunTransitions).toHaveLength(1);
    expect(typeof updateRunTransitions[0]!["outputOffset"]).toBe("number");
  });

  it("publish called for all provider events in order", async () => {
    const published: ProviderEvent[] = [];
    const applyCommand = vi.fn(async (_cmd: Command): Promise<CommandResult> => makeCommandResult());

    const events: ProviderEvent[] = [
      { kind: "assistant_text", text: "hello" },
      { kind: "thinking", text: "hmm" },
      { kind: "tool_call", id: "tc-1", name: "bash", input: { cmd: "ls" } },
      { kind: "tool_result", id: "tc-1", output: "file.txt" },
      { kind: "usage", inputTokens: 10, outputTokens: 5 },
      { kind: "final", sessionRef: "ref-x" },
    ];
    // One chunk per frame so each line triggers a parseFrame call
    const chunks = makeChunks(["l1", "l2", "l3", "l4", "l5", "l6"], 0);

    const orchestrator = makeOrchestrator(
      events.map((e) => [e]),
      chunks,
      applyCommand,
      undefined,
      (e) => published.push(e),
    );
    await orchestrator.run();

    expect(published).toHaveLength(6);
    expect(published.map((e) => e.kind)).toEqual([
      "assistant_text", "thinking", "tool_call", "tool_result", "usage", "final",
    ]);
  });

  it("publish throws sync: error propagates to outer catch, orchestrator dispatches mark-interrupted", async () => {
    const calls: string[] = [];
    const applyCommand = vi.fn(async (cmd: Command): Promise<CommandResult> => {
      if (cmd.kind === "transition-task") calls.push(cmd.transition.kind);
      return makeCommandResult();
    });

    const finalEvent: ProviderEvent = { kind: "final", sessionRef: "ref-y" };
    const chunks = makeChunks(["line-1"], 0);

    const orchestrator = makeOrchestrator(
      [[finalEvent]],
      chunks,
      applyCommand,
      undefined,
      () => { throw new Error("publish exploded"); },
    );
    await expect(orchestrator.run()).resolves.toBeUndefined();
    expect(calls).toContain("mark-interrupted");
    expect(calls).not.toContain("complete-runtime");
  });

  it("publish throws on final event: finalReceived prevents outputOffset write, mark-interrupted dispatched", async () => {
    const updateRunTransitions: Array<Record<string, unknown>> = [];
    const calls: string[] = [];
    const applyCommand = vi.fn(async (cmd: Command): Promise<CommandResult> => {
      if (cmd.kind === "transition-task") {
        calls.push(cmd.transition.kind);
        if (cmd.transition.kind === "update-run") {
          updateRunTransitions.push(cmd.transition as unknown as Record<string, unknown>);
        }
      }
      return makeCommandResult();
    });

    const finalEvent: ProviderEvent = { kind: "final", sessionRef: "ref-final-throw" };
    const chunks = makeChunks(["line-1"], 0);

    const orchestrator = makeOrchestrator(
      [[finalEvent]],
      chunks,
      applyCommand,
      undefined,
      (e) => { if (e.kind === "final") throw new Error("publish exploded on final"); },
    );
    await expect(orchestrator.run()).resolves.toBeUndefined();

    expect(calls).toContain("mark-interrupted");
    expect(calls).not.toContain("complete-runtime");
    const offsetWrite = updateRunTransitions.find((t) => t["outputOffset"] !== undefined);
    expect(offsetWrite).toBeUndefined();
  });

  it("error{recoverable:false} then final: both published, then mark-interrupted fires", async () => {
    const published: ProviderEvent[] = [];
    const calls: string[] = [];
    const applyCommand = vi.fn(async (cmd: Command): Promise<CommandResult> => {
      if (cmd.kind === "transition-task") calls.push(cmd.transition.kind);
      return makeCommandResult();
    });

    const errorEvent: ProviderEvent = { kind: "error", recoverable: false, message: "failed" };
    const finalEvent: ProviderEvent = { kind: "final", sessionRef: "ref-z" };
    const chunks = makeChunks(["line-1", "line-2"], 0);

    const orchestrator = makeOrchestrator(
      [[errorEvent], [finalEvent]],
      chunks,
      applyCommand,
      undefined,
      (e) => published.push(e),
    );
    await orchestrator.run();

    expect(published.map((e) => e.kind)).toContain("error");
    expect(published.map((e) => e.kind)).toContain("final");
    const errorIdx = published.findIndex((e) => e.kind === "error");
    const finalIdx = published.findIndex((e) => e.kind === "final");
    expect(errorIdx).toBeLessThan(finalIdx);
    expect(calls).toContain("mark-interrupted");
    expect(calls).not.toContain("complete-runtime");
  });

  it("version_conflict on complete-runtime: retries and succeeds, mark-interrupted not dispatched", async () => {
    const calls: string[] = [];
    let completeRuntimeAttempts = 0;
    const applyCommand = vi.fn(async (cmd: Command): Promise<CommandResult> => {
      if (cmd.kind === "transition-task") {
        calls.push(cmd.transition.kind);
        if (cmd.transition.kind === "complete-runtime") {
          completeRuntimeAttempts++;
          if (completeRuntimeAttempts === 1) {
            throw new DomainError("version_conflict", "concurrent write", { taskId: "task-1" });
          }
        }
      }
      return makeCommandResult();
    });

    const finalEvent: ProviderEvent = { kind: "final", sessionRef: "ref-retry" };
    const chunks = makeChunks(["line-1"], 0);

    const orchestrator = makeOrchestrator([[finalEvent]], chunks, applyCommand);
    await orchestrator.run();

    expect(completeRuntimeAttempts).toBe(2);
    expect(calls.filter((k) => k === "complete-runtime")).toHaveLength(2);
    expect(calls).not.toContain("mark-interrupted");
  });

  it("post complete-runtime: workspace.cleanup NOT called (workspace preserved until slice 17)", async () => {
    const applyCommand = vi.fn(async (_cmd: Command): Promise<CommandResult> => makeCommandResult());
    const workspace = new StubWorkspaceBackend();
    const cleanupSpy = vi.spyOn(workspace, "cleanup");

    const finalEvent: ProviderEvent = { kind: "final", sessionRef: "ref-x" };
    const chunks = makeChunks(["line-1"], 0);
    const provider = new StubProviderPlugin({ frames: [[finalEvent]] });
    const runtime = makeRuntime(chunks);

    const orch = new RunOrchestrator({
      workflowId: "wf-1",
      taskId: "task-1",
      runId: "run-1",
      runtimeSessionId: "session-1",
      provider,
      runtime,
      workspace,
      workspaceId: "ws-wf1_task1",
      applyCommand,
      publish: () => {},
      now: () => now,
      log: silentLogger(),
    });
    await orch.run();

    expect(cleanupSpy).not.toHaveBeenCalled();
  });

  it("post mark-interrupted: workspace.cleanup called", async () => {
    const applyCommand = vi.fn(async (_cmd: Command): Promise<CommandResult> => makeCommandResult());
    const workspace = new StubWorkspaceBackend();
    const cleanupSpy = vi.spyOn(workspace, "cleanup");

    const chunks = makeChunks(["line-1"], 0);
    const provider = new StubProviderPlugin({ frames: [] });
    const runtime = makeRuntime(chunks, new Error("stream exploded"));

    const orch = new RunOrchestrator({
      workflowId: "wf-1",
      taskId: "task-1",
      runId: "run-1",
      runtimeSessionId: "session-1",
      provider,
      runtime,
      workspace,
      workspaceId: "ws-wf1_task1",
      applyCommand,
      publish: () => {},
      now: () => now,
      log: silentLogger(),
    });
    await orch.run();

    expect(cleanupSpy).toHaveBeenCalledOnce();
    expect(cleanupSpy).toHaveBeenCalledWith("ws-wf1_task1");
  });

  it("workspace.cleanup throw on mark-interrupted path is swallowed; orchestrator exits cleanly", async () => {
    const applyCommand = vi.fn(async (_cmd: Command): Promise<CommandResult> => makeCommandResult());
    const workspace = new StubWorkspaceBackend();
    vi.spyOn(workspace, "cleanup").mockRejectedValue(new Error("cleanup failed hard"));

    const chunks = makeChunks(["line-1"], 0);
    const provider = new StubProviderPlugin({ frames: [] });
    const runtime = makeRuntime(chunks, new Error("stream exploded"));

    const orch = new RunOrchestrator({
      workflowId: "wf-1",
      taskId: "task-1",
      runId: "run-1",
      runtimeSessionId: "session-1",
      provider,
      runtime,
      workspace,
      workspaceId: "ws-wf1_task1",
      applyCommand,
      publish: () => {},
      now: () => now,
      log: silentLogger(),
    });
    await expect(orch.run()).resolves.toBeUndefined();
  });

  it("signal-abort path does NOT call workspace.cleanup", async () => {
    const applyCommand = vi.fn(async (_cmd: Command): Promise<CommandResult> => makeCommandResult());
    const workspace = new StubWorkspaceBackend();
    const cleanupSpy = vi.spyOn(workspace, "cleanup");

    const controller = new AbortController();
    controller.abort();

    const runtime: RuntimeBackend = {
      start: vi.fn(),
      stop: vi.fn(),
      probe: vi.fn().mockResolvedValue("live" as RuntimeProbeState),
      attach(_sessionId: string, _opts?: RuntimeAttachOptions): AsyncIterable<RuntimeOutputChunk> {
        return { [Symbol.asyncIterator]: async function* () {} };
      },
    };

    const provider = new StubProviderPlugin({ frames: [] });
    const orch = new RunOrchestrator({
      workflowId: "wf-1",
      taskId: "task-1",
      runId: "run-1",
      runtimeSessionId: "session-1",
      provider,
      runtime,
      workspace,
      workspaceId: "ws-wf1_task1",
      applyCommand,
      publish: () => {},
      now: () => now,
      signal: controller.signal,
      log: silentLogger(),
    });

    await orch.run();

    expect(cleanupSpy).not.toHaveBeenCalled();
  });
});
