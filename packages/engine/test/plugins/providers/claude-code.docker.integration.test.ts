import { describe, it, expect, beforeAll } from "vitest";
import { TmuxRuntimeBackend } from "../../../src/plugins/tmux/tmux-runtime.js";
import { ClaudeCodeProvider } from "../../../src/plugins/providers/claude-code.js";
import { runProvider } from "../../../src/plugins/providers/run-provider.js";
import type { ProviderEvent } from "../../../src/plugins/provider-plugin.js";

const WORKER_SESSIONS_DIR = process.env["MWF_DOCKER_WORKER_SESSIONS_DIR"] ?? "/sessions";
const CONTAINER = process.env["MWF_DOCKER_CONTAINER"] ?? "minions-worker";
const HOST_DATA_DIR = process.env["MWF_DOCKER_HOST_DATA_DIR"] ?? "/var/lib/minions";

describe.skipIf(process.env["MWF_HAS_DOCKER"] !== "1")("ClaudeCodeProvider docker integration", () => {
  let runtime: TmuxRuntimeBackend;

  beforeAll(() => {
    runtime = new TmuxRuntimeBackend({
      dataDir: HOST_DATA_DIR,
      workerSessionsDir: WORKER_SESSIONS_DIR,
      commandPrefix: ["docker", "exec", CONTAINER],
    });
  });

  it("prepare → start → runProvider: ≥1 assistant_text, exactly 1 usage, exactly 1 final with UUID sessionRef, no error events", async () => {
    const provider = new ClaudeCodeProvider();
    const invocation = await provider.prepare({
      taskId: "docker-claude-test",
      workflowId: "wf-docker-claude",
      prompt: "say hi",
      dependencyArtifacts: [],
    });

    const { sessionId } = await runtime.start({
      taskId: "docker-claude-test",
      workflowId: "wf-docker-claude",
      command: invocation.command,
    });

    const events: ProviderEvent[] = [];
    for await (const item of runProvider(runtime, sessionId, provider)) {
      if (item.kind === "provider") events.push(item.event);
    }

    const assistantTextEvents = events.filter((e) => e.kind === "assistant_text");
    const usageEvents = events.filter((e) => e.kind === "usage");
    const finalEvents = events.filter((e) => e.kind === "final");
    const errorEvents = events.filter((e) => e.kind === "error");

    expect(assistantTextEvents.length).toBeGreaterThanOrEqual(1);
    expect(usageEvents).toHaveLength(1);
    expect(finalEvents).toHaveLength(1);
    expect(errorEvents).toHaveLength(0);

    const finalEvent = finalEvents[0] as ProviderEvent & { kind: "final" };
    expect(finalEvent.sessionRef).toMatch(/^[0-9a-f-]{36}$/);
  }, 60000);
});
