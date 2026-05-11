import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadWorkflowAndSubscribe, state } from "../../pwa/assets/app-v1.js";

function makeWorkflow(id: string) {
  return { id, status: "running", graph: {} };
}

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  state.currentWorkflow = null;
  state.currentId = null;
  state.transcript = [];
  state.error = null;
  vi.restoreAllMocks();
});

describe("loadWorkflowAndSubscribe stale-load race", () => {
  it("drops A's late response when B navigates before A resolves", async () => {
    let resolveA!: (v: Response) => void;
    const fetchA = new Promise<Response>((res) => { resolveA = res; });

    const wfA = makeWorkflow("a");
    const wfB = makeWorkflow("b");

    vi.stubGlobal("fetch", (url: string) => {
      if (url === "/workflows/a") return fetchA;
      if (url === "/workflows/b") return Promise.resolve(new Response(JSON.stringify(wfB)));
      return Promise.resolve(new Response(JSON.stringify({})));
    });
    vi.stubGlobal("EventSource", class {
      addEventListener() {}
      close() {}
      set onerror(_v: unknown) {}
    });

    loadWorkflowAndSubscribe("a");
    loadWorkflowAndSubscribe("b");

    // Let B's fetch settle
    await new Promise<void>((r) => setTimeout(r, 0));

    // Now resolve A's late response
    resolveA(new Response(JSON.stringify(wfA)));
    await new Promise<void>((r) => setTimeout(r, 0));

    expect((state.currentWorkflow as { id: string } | null)?.id).toBe("b");
  });
});
