import { sleep } from "../util/time.js";
import { newId } from "../util/ids.js";
import type {
  AgentProvider,
  ProviderHandle,
  ProviderSpawnOpts,
  ProviderResumeOpts,
  ProviderEvent,
  ParseStreamState,
} from "./provider.js";

function makeCannedEvents(prompt: string): ProviderEvent[] {
  const toolCallId = newId();
  return [
    { kind: "turn_started" },
    { kind: "assistant_text", text: `Working on: ${prompt}` },
    {
      kind: "tool_call",
      toolCallId,
      toolName: "Read",
      input: { file_path: "/workspace/example.ts" },
    },
    {
      kind: "tool_result",
      toolCallId,
      toolName: "Read",
      status: "ok",
      body: "// example file content\nexport const example = true;\n",
    },
    { kind: "assistant_text", text: "Done." },
    { kind: "turn_completed", outcome: "success" },
  ];
}

function buildHandle(prompt: string, externalId: string): ProviderHandle {
  const events = makeCannedEvents(prompt);
  let done = false;
  let exitResolve: (v: { code: number | null; signal: NodeJS.Signals | null }) => void = () => {};
  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => {
    exitResolve = r;
  });

  const handle: ProviderHandle = {
    pid: undefined,
    externalId,
    kill(_signal) {
      done = true;
      exitResolve({ code: null, signal: _signal });
    },
    write(_text) {
    },
    async *[Symbol.asyncIterator]() {
      for (const ev of events) {
        if (done) break;
        await sleep(200);
        yield ev;
      }
      if (!done) {
        exitResolve({ code: 0, signal: null });
        done = true;
      }
    },
    waitForExit() {
      return exitPromise;
    },
  };

  return handle;
}

export const mockProvider: AgentProvider = {
  name: "mock",

  async spawn(opts: ProviderSpawnOpts): Promise<ProviderHandle> {
    const externalId = `mock-${opts.sessionSlug}`;
    return buildHandle(opts.prompt, externalId);
  },

  async resume(opts: ProviderResumeOpts): Promise<ProviderHandle> {
    const externalId = opts.externalId ?? `mock-${opts.sessionSlug}`;
    return buildHandle("(resumed)", externalId);
  },

  parseStreamChunk(_buf: string, state: ParseStreamState): { events: ProviderEvent[]; state: ParseStreamState } {
    return { events: [], state };
  },

  detectQuotaError(_text: string): boolean {
    return false;
  },
};
