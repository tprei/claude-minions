import { describe, it, expect, beforeAll } from "vitest";
import { TmuxRuntimeBackend } from "../../../src/plugins/tmux/tmux-runtime.js";
import { PiProvider } from "../../../src/plugins/providers/pi.js";
import { runProvider } from "../../../src/plugins/providers/run-provider.js";
import type { ProviderEvent } from "../../../src/plugins/provider-plugin.js";

const WORKER_SESSIONS_DIR = process.env["MWF_DOCKER_WORKER_SESSIONS_DIR"] ?? "/sessions";
const CONTAINER = process.env["MWF_DOCKER_CONTAINER"] ?? "minions-worker";
const HOST_DATA_DIR = process.env["MWF_DOCKER_HOST_DATA_DIR"] ?? "/var/lib/minions";

const UUID_RE = /^[0-9a-f-]{36}$/;

const guardSkip =
  process.env["MWF_HAS_DOCKER"] !== "1" || process.env["MWF_HAS_PI_AUTH"] !== "1";

describe.skipIf(guardSkip)("PiProvider docker integration", () => {
  let runtime: TmuxRuntimeBackend;

  beforeAll(() => {
    runtime = new TmuxRuntimeBackend({
      dataDir: HOST_DATA_DIR,
      workerSessionsDir: WORKER_SESSIONS_DIR,
      commandPrefix: ["docker", "exec", CONTAINER],
    });
  });

  it("prepare → start → runProvider: ≥1 assistant_text, exactly 1 usage, exactly 1 final with UUID sessionRef, no error events", async () => {
    const provider = new PiProvider();
    const invocation = await provider.prepare({
      taskId: "docker-pi-test",
      workflowId: "wf-docker-pi",
      prompt: "say hi",
      dependencyArtifacts: [],
    });

    const { sessionId } = await runtime.start({
      taskId: "docker-pi-test",
      workflowId: "wf-docker-pi",
      command: invocation.command,
      ...(invocation.env !== undefined ? { env: invocation.env } : {}),
    });

    const events: ProviderEvent[] = [];
    for await (const item of runProvider(runtime, sessionId, provider)) {
      if (item.kind === "provider") events.push(item.event);
    }

    const assistantTextEvents = events.filter((e) => e.kind === "assistant_text");
    const usageEvents = events.filter((e) => e.kind === "usage");
    const finalEvents = events.filter((e) => e.kind === "final");
    const nonRecoverableErrors = events.filter(
      (e) => e.kind === "error" && e.recoverable === false,
    );

    expect(assistantTextEvents.length).toBeGreaterThanOrEqual(1);
    expect(usageEvents).toHaveLength(1);
    expect(finalEvents).toHaveLength(1);
    expect(nonRecoverableErrors).toHaveLength(0);

    const finalEvent = finalEvents[0] as ProviderEvent & { kind: "final" };
    expect(finalEvent.sessionRef.length).toBeGreaterThan(0);
    expect(finalEvent.sessionRef).toMatch(UUID_RE);
  }, 120000);

  it("resume from previous sessionRef: ≥1 assistant_text, exactly 1 usage, exactly 1 final with UUID sessionRef, no non-recoverable error events", async () => {
    const first = new PiProvider();
    const firstInvocation = await first.prepare({
      taskId: "docker-pi-resume-seed",
      workflowId: "wf-docker-pi-resume",
      prompt: "say hi",
      dependencyArtifacts: [],
    });
    const firstStart = await runtime.start({
      taskId: "docker-pi-resume-seed",
      workflowId: "wf-docker-pi-resume",
      command: firstInvocation.command,
      ...(firstInvocation.env !== undefined ? { env: firstInvocation.env } : {}),
    });
    const firstEvents: ProviderEvent[] = [];
    for await (const item of runProvider(runtime, firstStart.sessionId, first)) {
      if (item.kind === "provider") firstEvents.push(item.event);
    }
    const firstFinal = firstEvents.find((e) => e.kind === "final") as
      | (ProviderEvent & { kind: "final" })
      | undefined;
    expect(firstFinal).toBeDefined();
    const seedSessionRef = firstFinal!.sessionRef;
    expect(seedSessionRef).toMatch(UUID_RE);

    const resumed = new PiProvider();
    const resumeInvocation = await resumed.resume({
      taskId: "docker-pi-resume",
      workflowId: "wf-docker-pi-resume",
      sessionRef: seedSessionRef,
      prompt: "again",
    });

    const { sessionId } = await runtime.start({
      taskId: "docker-pi-resume",
      workflowId: "wf-docker-pi-resume",
      command: resumeInvocation.command,
      ...(resumeInvocation.env !== undefined ? { env: resumeInvocation.env } : {}),
    });

    const events: ProviderEvent[] = [];
    for await (const item of runProvider(runtime, sessionId, resumed)) {
      if (item.kind === "provider") events.push(item.event);
    }

    const assistantTextEvents = events.filter((e) => e.kind === "assistant_text");
    const usageEvents = events.filter((e) => e.kind === "usage");
    const finalEvents = events.filter((e) => e.kind === "final");
    const nonRecoverableErrors = events.filter(
      (e) => e.kind === "error" && e.recoverable === false,
    );

    expect(assistantTextEvents.length).toBeGreaterThanOrEqual(1);
    expect(usageEvents).toHaveLength(1);
    expect(finalEvents).toHaveLength(1);
    expect(nonRecoverableErrors).toHaveLength(0);

    const finalEvent = finalEvents[0] as ProviderEvent & { kind: "final" };
    expect(finalEvent.sessionRef).toMatch(UUID_RE);
  }, 180000);

  it("tool call: prompt that forces a read emits matched tool_call and tool_result", async () => {
    const provider = new PiProvider();
    const invocation = await provider.prepare({
      taskId: "docker-pi-toolcall",
      workflowId: "wf-docker-pi-toolcall",
      prompt: "read the package.json and tell me the name field",
      dependencyArtifacts: [],
    });

    const { sessionId } = await runtime.start({
      taskId: "docker-pi-toolcall",
      workflowId: "wf-docker-pi-toolcall",
      command: invocation.command,
      ...(invocation.env !== undefined ? { env: invocation.env } : {}),
    });

    const events: ProviderEvent[] = [];
    for await (const item of runProvider(runtime, sessionId, provider)) {
      if (item.kind === "provider") events.push(item.event);
    }

    const toolCalls = events.filter((e) => e.kind === "tool_call") as Array<
      ProviderEvent & { kind: "tool_call" }
    >;
    const toolResults = events.filter((e) => e.kind === "tool_result") as Array<
      ProviderEvent & { kind: "tool_result" }
    >;

    expect(toolCalls.length).toBeGreaterThanOrEqual(1);

    const callIds = new Set(toolCalls.map((c) => c.id));
    const matched = toolResults.find((r) => callIds.has(r.id));
    expect(matched).toBeDefined();
  }, 120000);
});
