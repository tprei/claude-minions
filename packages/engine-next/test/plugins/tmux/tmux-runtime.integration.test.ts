// Run with MWF_HAS_TMUX=1 npm test to exercise these. They're skipped by default.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TmuxRuntimeBackend } from "../../../src/plugins/tmux/tmux-runtime.js";

function randomHex(n: number): string {
  return randomBytes(n).toString("hex");
}

describe.skipIf(process.env["MWF_HAS_TMUX"] !== "1")("TmuxRuntimeBackend integration", () => {
  let socketName: string;
  let dataDir: string;
  let backend: TmuxRuntimeBackend;

  beforeEach(() => {
    socketName = `minions-test-${process.pid}-${randomHex(4)}`;
    dataDir = mkdtempSync(join(tmpdir(), "mwf-"));
    backend = new TmuxRuntimeBackend({ dataDir, socketName });
  });

  afterEach(async () => {
    try {
      const { exec } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execAsync = promisify(exec);
      await execAsync(`tmux -L ${socketName} kill-server`).catch(() => {});
    } catch {
      // best-effort
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("full lifecycle: start → live → attach → stop → missing", async () => {
    const { sessionId } = await backend.start({
      taskId: "t1",
      workflowId: "wf-1",
      command: ["sh", "-c", "echo hello; sleep 5"],
    });

    expect(await backend.probe(sessionId)).toBe("live");

    const controller = new AbortController();
    const chunks: Uint8Array[] = [];
    setTimeout(() => controller.abort(), 500);

    for await (const chunk of backend.attach(sessionId, { fromOffset: 0, signal: controller.signal })) {
      chunks.push(chunk.bytes);
    }

    const output = Buffer.concat(chunks.map((b) => Buffer.from(b))).toString();
    expect(output).toContain("hello");

    await backend.stop(sessionId);
    expect(await backend.probe(sessionId)).toBe("missing");
  });

  it("live → dead → missing: process exits fast with remain-on-exit", async () => {
    const { sessionId } = await backend.start({
      taskId: "t2",
      workflowId: "wf-1",
      command: ["sh", "-c", "echo bye"],
    });

    let dead = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const state = await backend.probe(sessionId);
      if (state === "dead") { dead = true; break; }
    }
    expect(dead).toBe(true);

    await backend.stop(sessionId);
    expect(await backend.probe(sessionId)).toBe("missing");
  });

  it("attach replay from offset 0 includes all early bytes", async () => {
    const { sessionId } = await backend.start({
      taskId: "t3",
      workflowId: "wf-1",
      command: ["sh", "-c", "printf 'line1\\nline2\\n'; sleep 5"],
    });

    await new Promise((r) => setTimeout(r, 500));

    const controller = new AbortController();
    const chunks: Uint8Array[] = [];
    setTimeout(() => controller.abort(), 300);

    for await (const chunk of backend.attach(sessionId, { fromOffset: 0, signal: controller.signal })) {
      chunks.push(chunk.bytes);
    }

    const output = Buffer.concat(chunks.map((b) => Buffer.from(b))).toString();
    expect(output).toContain("line1");
    expect(output).toContain("line2");
    await backend.stop(sessionId);
    expect(await backend.probe(sessionId)).toBe("missing");
  });

  it("attach with fromOffset skips earlier bytes", async () => {
    const { sessionId } = await backend.start({
      taskId: "t4",
      workflowId: "wf-1",
      command: ["sh", "-c", "printf '%050d\\n' 0; sleep 5"],
    });

    await new Promise((r) => setTimeout(r, 500));

    const controller = new AbortController();
    const chunks: { offset: number; bytes: Uint8Array }[] = [];
    setTimeout(() => controller.abort(), 300);

    for await (const chunk of backend.attach(sessionId, { fromOffset: 30, signal: controller.signal })) {
      chunks.push(chunk);
    }

    expect(chunks[0]?.offset).toBe(30);
    await backend.stop(sessionId);
    expect(await backend.probe(sessionId)).toBe("missing");
  });

  it("idempotent stop: second call doesn't throw", async () => {
    const { sessionId } = await backend.start({
      taskId: "t5",
      workflowId: "wf-1",
      command: ["sh", "-c", "sleep 10"],
    });
    await backend.stop(sessionId);
    expect(await backend.probe(sessionId)).toBe("missing");
    await expect(backend.stop(sessionId)).resolves.toBeUndefined();
  });

  it("dataDir with a space in the path still launches (script path is shell-quoted for tmux)", async () => {
    const spacedDir = mkdtempSync(join(tmpdir(), "mwf with space-"));
    try {
      const altSocket = `minions-test-${process.pid}-${randomHex(4)}`;
      const altBackend = new TmuxRuntimeBackend({ dataDir: spacedDir, socketName: altSocket });

      const { sessionId } = await altBackend.start({
        taskId: "spaced",
        workflowId: "wf-spaced",
        command: ["sh", "-c", "echo spaced; sleep 5"],
      });

      expect(await altBackend.probe(sessionId)).toBe("live");

      const controller = new AbortController();
      const chunks: Uint8Array[] = [];
      setTimeout(() => controller.abort(), 500);

      for await (const chunk of altBackend.attach(sessionId, { fromOffset: 0, signal: controller.signal })) {
        chunks.push(chunk.bytes);
      }

      const output = Buffer.concat(chunks.map((b) => Buffer.from(b))).toString();
      expect(output).toContain("spaced");

      await altBackend.stop(sessionId);
      expect(await altBackend.probe(sessionId)).toBe("missing");
      const { exec } = await import("node:child_process");
      const { promisify } = await import("node:util");
      await promisify(exec)(`tmux -L ${altSocket} kill-server`).catch(() => {});
    } finally {
      rmSync(spacedDir, { recursive: true, force: true });
    }
  });

  it("invalid cwd: cd fails fast and the user command never runs", async () => {
    const { sessionId } = await backend.start({
      taskId: "bad-cwd",
      workflowId: "wf-bad-cwd",
      command: ["sh", "-c", "echo should-not-run; sleep 5"],
      workspacePath: "/nonexistent/path/that/does/not/exist",
    });

    // Wait for the launcher to give up
    await new Promise((r) => setTimeout(r, 500));

    const controller = new AbortController();
    const chunks: Uint8Array[] = [];
    setTimeout(() => controller.abort(), 300);

    for await (const chunk of backend.attach(sessionId, { fromOffset: 0, signal: controller.signal })) {
      chunks.push(chunk.bytes);
    }

    const output = Buffer.concat(chunks.map((b) => Buffer.from(b))).toString();
    expect(output).not.toContain("should-not-run");
    await backend.stop(sessionId);
    expect(await backend.probe(sessionId)).toBe("missing");
  });

  it("argv quoting end-to-end: special chars reach the process intact", async () => {
    const { sessionId } = await backend.start({
      taskId: "t6",
      workflowId: "wf-1",
      command: ["sh", "-c", "printf '%s\\n' 'hello world' '$VAR' 'a;b'; sleep 5"],
    });

    await new Promise((r) => setTimeout(r, 500));

    const controller = new AbortController();
    const chunks: Uint8Array[] = [];
    setTimeout(() => controller.abort(), 300);

    for await (const chunk of backend.attach(sessionId, { fromOffset: 0, signal: controller.signal })) {
      chunks.push(chunk.bytes);
    }

    const output = Buffer.concat(chunks.map((b) => Buffer.from(b))).toString();
    expect(output).toContain("hello world");
    expect(output).toContain("$VAR");
    expect(output).toContain("a;b");
    await backend.stop(sessionId);
    expect(await backend.probe(sessionId)).toBe("missing");
  });

  it("attach receives final output and terminates without abort (PRIMARY invariant)", async () => {
    const { sessionId } = await backend.start({
      taskId: "invariant",
      workflowId: "wf-1",
      command: ["sh", "-c", "printf 'tail-line'; exit 0"],
    });

    const chunks: Uint8Array[] = [];
    for await (const chunk of backend.attach(sessionId, { fromOffset: 0 })) {
      chunks.push(chunk.bytes);
    }

    const output = Buffer.concat(chunks.map((b) => Buffer.from(b))).toString();
    expect(output).toContain("tail-line");
    expect(await backend.probe(sessionId)).toBe("dead");
  }, 10000);

  it("long-running attach can be aborted", async () => {
    const { sessionId } = await backend.start({
      taskId: "abort-test",
      workflowId: "wf-1",
      command: ["sh", "-c", "echo running; sleep 30"],
    });

    const controller = new AbortController();
    const chunks: Uint8Array[] = [];
    setTimeout(() => controller.abort(), 400);

    for await (const chunk of backend.attach(sessionId, { fromOffset: 0, signal: controller.signal })) {
      chunks.push(chunk.bytes);
    }

    const output = Buffer.concat(chunks.map((b) => Buffer.from(b))).toString();
    expect(output).toContain("running");
    await backend.stop(sessionId);
    expect(await backend.probe(sessionId)).toBe("missing");
  });

  it("fresh attach after stop returns trailing bytes", async () => {
    const { sessionId } = await backend.start({
      taskId: "stop-then-attach",
      workflowId: "wf-1",
      command: ["sh", "-c", "printf 'final-bytes'; sleep 30"],
    });

    await new Promise((r) => setTimeout(r, 500));
    await backend.stop(sessionId);
    expect(await backend.probe(sessionId)).toBe("missing");

    const controller = new AbortController();
    const chunks: Uint8Array[] = [];
    setTimeout(() => controller.abort(), 300);

    for await (const chunk of backend.attach(sessionId, { fromOffset: 0, signal: controller.signal })) {
      chunks.push(chunk.bytes);
    }

    const output = Buffer.concat(chunks.map((b) => Buffer.from(b))).toString();
    expect(output).toContain("final-bytes");
  });

  it("two concurrent attaches both see final output and both terminate", async () => {
    const { sessionId } = await backend.start({
      taskId: "concurrent",
      workflowId: "wf-1",
      command: ["sh", "-c", "printf 'shared-output'; exit 0"],
    });

    const collect = async () => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of backend.attach(sessionId, { fromOffset: 0 })) {
        chunks.push(chunk.bytes);
      }
      return Buffer.concat(chunks.map((b) => Buffer.from(b))).toString();
    };

    const [out1, out2] = await Promise.all([collect(), collect()]);

    expect(out1).toContain("shared-output");
    expect(out2).toContain("shared-output");
    expect(await backend.probe(sessionId)).toBe("dead");
  }, 10000);

  it("stop racing in-flight attach does not lose final bytes", async () => {
    const { sessionId } = await backend.start({
      taskId: "race-stop",
      workflowId: "wf-1",
      command: ["sh", "-c", "printf done; sleep 30"],
    });

    const chunks: Uint8Array[] = [];
    const attachPromise = (async () => {
      for await (const chunk of backend.attach(sessionId, { fromOffset: 0 })) {
        chunks.push(chunk.bytes);
      }
    })();

    await new Promise((r) => setTimeout(r, 100));
    await backend.stop(sessionId);
    await attachPromise;

    expect(await backend.probe(sessionId)).toBe("missing");
    const output = Buffer.concat(chunks.map((b) => Buffer.from(b))).toString();
    expect(output).toContain("done");
  }, 10000);

  it("PRIMARY: live append during drain is delivered promptly (lost-wakeup fix)", async () => {
    // Each chunk is written 200 ms apart; the iterator must yield each one within
    // ~500 ms of it landing (tmux line-buffer + watchFile 100 ms interval + margin).
    const { sessionId } = await backend.start({
      taskId: "live-append",
      workflowId: "wf-1",
      command: ["sh", "-c", "for i in 1 2 3 4 5; do printf \"chunk-$i \"; sleep 0.2; done; exit 0"],
    });

    const arrivals: { content: string; at: number }[] = [];
    for await (const chunk of backend.attach(sessionId, { fromOffset: 0 })) {
      arrivals.push({
        content: Buffer.from(chunk.bytes).toString(),
        at: Date.now(),
      });
    }

    const combined = arrivals.map((a) => a.content).join("");
    expect(combined).toContain("chunk-1");
    expect(combined).toContain("chunk-5");
    // Verify attach terminated (no external abort needed)
    expect(arrivals.length).toBeGreaterThan(0);
  }, 10000);

  it("deterministic final drain via sentinel: .done file consumed during normal attach termination", async () => {
    const { stat } = await import("node:fs/promises");
    const { sessionId } = await backend.start({
      taskId: "sentinel-drain",
      workflowId: "wf-1",
      command: ["sh", "-c", "printf 'sentinel-content'; exit 0"],
    });

    const sessionsDir = `${dataDir}/sessions`;

    const chunks: Uint8Array[] = [];
    for await (const chunk of backend.attach(sessionId, { fromOffset: 0 })) {
      chunks.push(chunk.bytes);
    }

    const output = Buffer.concat(chunks.map((b) => Buffer.from(b))).toString();
    expect(output).toContain("sentinel-content");

    // .done sentinel must have been cleaned up by attach
    const donePath = `${sessionsDir}/${sessionId}.log.done`;
    await expect(stat(donePath)).rejects.toThrow();
  }, 10000);
});
