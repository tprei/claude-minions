import { describe, it, expect, beforeAll } from "vitest";
import { TmuxRuntimeBackend } from "../../../src/plugins/tmux/tmux-runtime.js";
import { CodexProvider } from "../../../src/plugins/providers/codex.js";
import { runProvider } from "../../../src/plugins/providers/run-provider.js";
import type { ProviderEvent } from "../../../src/plugins/provider-plugin.js";


const WORKER_SESSIONS_DIR = process.env["MWF_DOCKER_WORKER_SESSIONS_DIR"] ?? "/sessions";
const CONTAINER = process.env["MWF_DOCKER_CONTAINER"] ?? "minions-worker";
const HOST_DATA_DIR = process.env["MWF_DOCKER_HOST_DATA_DIR"] ?? "/var/lib/minions";

describe.skipIf(process.env["MWF_HAS_DOCKER"] !== "1")("CodexProvider docker integration", () => {
  let runtime: TmuxRuntimeBackend;

  beforeAll(() => {
    runtime = new TmuxRuntimeBackend({
      dataDir: HOST_DATA_DIR,
      workerSessionsDir: WORKER_SESSIONS_DIR,
      commandPrefix: ["docker", "exec", CONTAINER],
    });
  });

  it("prepare → start → runProvider: ≥1 assistant_text, exactly 1 usage, exactly 1 final with non-empty sessionRef, no error events", async () => {
    const provider = new CodexProvider();
    const invocation = await provider.prepare({
      taskId: "docker-codex-test",
      workflowId: "wf-docker-codex",
      prompt: "say hi",
      dependencyArtifacts: [],
    });

    const { sessionId } = await runtime.start({
      taskId: "docker-codex-test",
      workflowId: "wf-docker-codex",
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
    expect(finalEvent.sessionRef.length).toBeGreaterThan(0);
  }, 60000);
});
