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
  persistTranscript?: (occurredAt: string, event: ProviderEvent) => Promise<void>,
  runtimeOverride?: RuntimeBackend,
) {
  const provider = new StubProviderPlugin({ frames: providerFrames });
  const runtime = runtimeOverride ?? makeRuntime(chunks, shouldThrow);

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
    ...(persistTranscript ? { persistTranscript } : {}),
    now: () => now,
    log: silentLogger(),
  });
}

describe("RunOrchestrator", () => {
  it("happy path: offset from earlier chunk + final with sessionRef → update-run then complete-runtime then clear-session in order", async () => {
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

    expect(calls).toEqual(["update-run", "complete-runtime", "clear-session"]);

    const updateCall = applyCommand.mock.calls.find(
      ([cmd]) => cmd.kind === "transition-task" && cmd.transition.kind === "update-run",
    );
    expect(updateCall).toBeDefined();
    const t = (updateCall![0] as Extract<Command, { kind: "transition-task" }>).transition;
    expect(t.providerSessionRef).toBe("abc-ref");
    // outputOffset must NOT be written on the success path — prevents offset-after-final race
    expect(t.outputOffset).toBeUndefined();
  });

  it("happy path stops the runtime session after complete-runtime", async () => {
    const applyCommand = vi.fn(async (_cmd: Command): Promise<CommandResult> => makeCommandResult());
    const finalEvent: ProviderEvent = { kind: "final", sessionRef: "abc-ref" };
    const runtime = makeRuntime(makeChunks(["line-1"], 0));

    const orchestrator = makeOrchestrator([[finalEvent]], makeChunks(["line-1"], 0), applyCommand, undefined, undefined, undefined, runtime);
    await orchestrator.run();

    expect(runtime.stop).toHaveBeenCalledOnce();
    expect(runtime.stop).toHaveBeenCalledWith("session-1");
  });

  it("happy path clears the durable session only after runtime.stop succeeds", async () => {
    const calls: string[] = [];
    const applyCommand = vi.fn(async (cmd: Command): Promise<CommandResult> => {
      if (cmd.kind === "transition-task") calls.push(cmd.transition.kind);
      return makeCommandResult();
    });
    const finalEvent: ProviderEvent = { kind: "final", sessionRef: "abc-ref" };
    const runtime = makeRuntime(makeChunks(["line-1"], 0));

    const orchestrator = makeOrchestrator([[finalEvent]], makeChunks(["line-1"], 0), applyCommand, undefined, undefined, undefined, runtime);
    await orchestrator.run();

    const stopOrder = (runtime.stop as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const clearOrder = applyCommand.mock.calls.findIndex(
      ([cmd]) => cmd.kind === "transition-task" && cmd.transition.kind === "clear-session",
    );

    expect(stopOrder).toBeGreaterThan(0);
    expect(clearOrder).toBeGreaterThan(-1);
    expect((applyCommand.mock.calls[clearOrder]?.[0] as Extract<Command, { kind: "transition-task" }>).transition.expectedSessionId).toBe("session-1");
  });

  it("happy path leaves the durable session in place when runtime.stop fails", async () => {
    const calls: string[] = [];
    const applyCommand = vi.fn(async (cmd: Command): Promise<CommandResult> => {
      if (cmd.kind === "transition-task") calls.push(cmd.transition.kind);
      return makeCommandResult();
    });
    const finalEvent: ProviderEvent = { kind: "final", sessionRef: "abc-ref" };
    const runtime = makeRuntime(makeChunks(["line-1"], 0));
    (runtime.stop as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("stop failed"));

    const orchestrator = makeOrchestrator([[finalEvent]], makeChunks(["line-1"], 0), applyCommand, undefined, undefined, undefined, runtime);
    await orchestrator.run();

    expect(calls).toEqual(["update-run", "complete-runtime"]);
    expect(runtime.stop).toHaveBeenCalledOnce();
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

  it("mark-interrupted path stops the runtime session", async () => {
    const applyCommand = vi.fn(async (_cmd: Command): Promise<CommandResult> => makeCommandResult());
    const runtime = makeRuntime(makeChunks(["line-1"], 0), new Error("stream exploded"));

    const orchestrator = makeOrchestrator([], makeChunks(["line-1"], 0), applyCommand, new Error("stream exploded"), undefined, undefined, runtime);
    await orchestrator.run();

    expect(runtime.stop).toHaveBeenCalledOnce();
    expect(runtime.stop).toHaveBeenCalledWith("session-1");
  });

  it("empty final.sessionRef with no prior sessionRef → no update-run dispatched, complete-runtime then clear-session fire", async () => {
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

    expect(calls).toEqual(["complete-runtime", "clear-session"]);
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

    expect(calls).toEqual(["update-run", "complete-runtime", "clear-session"]);
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

  it("provider error{recoverable:false} then final stops the runtime session", async () => {
    const applyCommand = vi.fn(async (_cmd: Command): Promise<CommandResult> => makeCommandResult());
    const errorEvent: ProviderEvent = { kind: "error", recoverable: false, message: "turn failed" };
    const finalEvent: ProviderEvent = { kind: "final", sessionRef: "ref-x" };
    const runtime = makeRuntime(makeChunks(["line-1", "line-2"], 0));

    const orchestrator = makeOrchestrator([[errorEvent], [finalEvent]], makeChunks(["line-1", "line-2"], 0), applyCommand, undefined, undefined, undefined, runtime);
    await orchestrator.run();

    expect(runtime.stop).toHaveBeenCalledOnce();
    expect(runtime.stop).toHaveBeenCalledWith("session-1");
  });

  it("stream idle timeout error then final → update-run then recover-task for scheduler resume", async () => {
    const calls: string[] = [];
    const workspace = new StubWorkspaceBackend();
    const cleanupSpy = vi.spyOn(workspace, "cleanup");
    const runtime = makeRuntime(makeChunks(["line-1", "line-2"], 0));
    const applyCommand = vi.fn(async (cmd: Command): Promise<CommandResult> => {
      if (cmd.kind === "transition-task") calls.push(cmd.transition.kind);
      return makeCommandResult();
    });

    const errorEvent: ProviderEvent = {
      kind: "error",
      recoverable: true,
      source: "stream_idle_timeout",
      message: "API Error: Stream idle timeout - partial response received",
    };
    const finalEvent: ProviderEvent = { kind: "final", sessionRef: "ref-idle" };
    const provider = new StubProviderPlugin({ frames: [[errorEvent], [finalEvent]] });
    const orchestrator = new RunOrchestrator({
      workflowId: "wf-1",
      taskId: "task-1",
      runId: "run-1",
      runtimeSessionId: "session-1",
      provider,
      runtime,
      workspace,
      workspaceId: "stub-wf1_task1",
      applyCommand,
      publish: () => {},
      now: () => now,
      log: silentLogger(),
    });

    await orchestrator.run();

    expect(calls).toEqual(["update-run", "recover-task"]);
    expect(applyCommand).toHaveBeenCalledWith(expect.objectContaining({
      kind: "transition-task",
      transition: expect.objectContaining({ kind: "recover-task", reason: "stream_idle_timeout" }),
    }));
    expect(calls).not.toContain("complete-runtime");
    expect(calls).not.toContain("mark-interrupted");
    expect(cleanupSpy).not.toHaveBeenCalled();
    expect(runtime.stop).toHaveBeenCalledOnce();
    expect(runtime.stop).toHaveBeenCalledWith("session-1");
  });

  it("stream idle timeout without final → update-run then recover-task instead of mark-interrupted", async () => {
    const calls: string[] = [];
    const workspace = new StubWorkspaceBackend();
    const cleanupSpy = vi.spyOn(workspace, "cleanup");
    const applyCommand = vi.fn(async (cmd: Command): Promise<CommandResult> => {
      if (cmd.kind === "transition-task") calls.push(cmd.transition.kind);
      return makeCommandResult();
    });

    const errorEvent: ProviderEvent = {
      kind: "error",
      recoverable: true,
      source: "stream_idle_timeout",
      message: "Anthropic API Error: Stream idle timeout - partial response received",
    };
    const provider = new StubProviderPlugin({ frames: [[errorEvent]] });
    const runtime = makeRuntime(makeChunks(["line-1"], 0));
    const orchestrator = new RunOrchestrator({
      workflowId: "wf-1",
      taskId: "task-1",
      runId: "run-1",
      runtimeSessionId: "session-1",
      provider,
      runtime,
      workspace,
      workspaceId: "stub-wf1_task1",
      applyCommand,
      publish: () => {},
      now: () => now,
      log: silentLogger(),
    });

    await orchestrator.run();

    expect(calls).toEqual(["update-run", "recover-task"]);
    expect(applyCommand).toHaveBeenCalledWith(expect.objectContaining({
      kind: "transition-task",
      transition: expect.objectContaining({ kind: "recover-task", reason: "stream_idle_timeout" }),
    }));
    expect(calls).not.toContain("mark-interrupted");
    expect(cleanupSpy).not.toHaveBeenCalled();
  });

  it("stream idle recovery stops the old runtime session after recover-task", async () => {
    const applyCommand = vi.fn(async (_cmd: Command): Promise<CommandResult> => makeCommandResult());
    const errorEvent: ProviderEvent = {
      kind: "error",
      recoverable: true,
      source: "stream_idle_timeout",
      message: "Anthropic API Error: Stream idle timeout - partial response received",
    };
    const runtime = makeRuntime(makeChunks(["line-1"], 0));
    const provider = new StubProviderPlugin({ frames: [[errorEvent]] });
    const orchestrator = new RunOrchestrator({
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
      log: silentLogger(),
    });

    await orchestrator.run();

    expect(runtime.stop).toHaveBeenCalledOnce();
    expect(runtime.stop).toHaveBeenCalledWith("session-1");
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

  it("persistTranscript called for persistent kinds (assistant_text, thinking, tool_call, tool_result, error) but not usage or final", async () => {
    const persisted: ProviderEvent[] = [];
    const applyCommand = vi.fn(async (_cmd: Command): Promise<CommandResult> => makeCommandResult());

    const events: ProviderEvent[] = [
      { kind: "assistant_text", text: "hello" },
      { kind: "thinking", text: "hmm" },
      { kind: "tool_call", id: "tc-1", name: "bash", input: { cmd: "ls" } },
      { kind: "tool_result", id: "tc-1", output: "file.txt" },
      { kind: "error", recoverable: true, message: "soft error" },
      { kind: "usage", inputTokens: 10, outputTokens: 5 },
      { kind: "final", sessionRef: "ref-x" },
    ];
    const chunks = makeChunks(events.map((_, i) => `l${i}`), 0);

    const orchestrator = makeOrchestrator(
      events.map((e) => [e]),
      chunks,
      applyCommand,
      undefined,
      undefined,
      async (_occurredAt, event) => { persisted.push(event); },
    );
    await orchestrator.run();

    expect(persisted.map((e) => e.kind)).toEqual([
      "assistant_text", "thinking", "tool_call", "tool_result", "error",
    ]);
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
