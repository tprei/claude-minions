import { type Mock, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeOutputChunk } from "../../../src/plugins/runtime-backend.js";

// Shared mock instance — all TmuxClient constructions return the same mock methods
const mockClient = {
  newSession: vi.fn().mockResolvedValue(undefined),
  setWindowOption: vi.fn().mockResolvedValue(undefined),
  pipePane: vi.fn().mockResolvedValue(undefined),
  pipePaneOff: vi.fn().mockResolvedValue(undefined),
  waitForSignal: vi.fn().mockResolvedValue(undefined),
  sessionExists: vi.fn().mockResolvedValue(true),
  paneDead: vi.fn().mockResolvedValue(false),
  killSession: vi.fn().mockResolvedValue(undefined),
};

vi.mock("../../../src/plugins/tmux/tmux-client.js", () => {
  const TmuxNoSuchSessionError = class extends Error {
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: number;
    constructor(stdout = "", stderr = "no such session", exitCode = 1) {
      super("no such session");
      this.name = "TmuxNoSuchSessionError";
      this.stdout = stdout;
      this.stderr = stderr;
      this.exitCode = exitCode;
    }
  };

  const TmuxError = class extends Error {
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: number;
    constructor(msg: string, stdout: string, stderr: string, exitCode: number) {
      super(msg);
      this.name = "TmuxError";
      this.stdout = stdout;
      this.stderr = stderr;
      this.exitCode = exitCode;
    }
  };

  const mockClientInner = {
    newSession: vi.fn().mockResolvedValue(undefined),
    setWindowOption: vi.fn().mockResolvedValue(undefined),
    pipePane: vi.fn().mockResolvedValue(undefined),
    pipePaneOff: vi.fn().mockResolvedValue(undefined),
    waitForSignal: vi.fn().mockResolvedValue(undefined),
    sessionExists: vi.fn().mockResolvedValue(true),
    paneDead: vi.fn().mockResolvedValue(false),
    killSession: vi.fn().mockResolvedValue(undefined),
  };

  // Use class syntax so `new` works correctly with vitest
  class TmuxClient {
    newSession = mockClientInner.newSession;
    setWindowOption = mockClientInner.setWindowOption;
    pipePane = mockClientInner.pipePane;
    pipePaneOff = mockClientInner.pipePaneOff;
    waitForSignal = mockClientInner.waitForSignal;
    sessionExists = mockClientInner.sessionExists;
    paneDead = mockClientInner.paneDead;
    killSession = mockClientInner.killSession;
  }

  return { TmuxClient, TmuxError, TmuxNoSuchSessionError, _mockClientInner: mockClientInner };
});

const mockFileHandle = {
  stat: vi.fn().mockResolvedValue({ size: 0 }),
  read: vi.fn().mockResolvedValue({ bytesRead: 0 }),
  close: vi.fn().mockResolvedValue(undefined),
};

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    access: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
    open: vi.fn().mockResolvedValue(mockFileHandle),
  };
});

vi.mock("../../../src/plugins/tmux/log-follow.js", () => ({
  followLog: vi.fn().mockImplementation(async function* () {}),
}));

interface MockClientInner {
  newSession: Mock;
  setWindowOption: Mock;
  pipePane: Mock;
  pipePaneOff: Mock;
  waitForSignal: Mock;
  sessionExists: Mock;
  paneDead: Mock;
  killSession: Mock;
}

async function getMockClientInner(): Promise<MockClientInner> {
  const mod = (await import("../../../src/plugins/tmux/tmux-client.js")) as unknown as {
    _mockClientInner: MockClientInner;
  };
  return mod._mockClientInner;
}

async function getFollowLogMock() {
  const mod = await import("../../../src/plugins/tmux/log-follow.js");
  return mod.followLog as unknown as Mock;
}

async function getFsMock() {
  const mod = await import("node:fs/promises");
  return {
    mkdir: mod.mkdir as unknown as Mock,
    writeFile: mod.writeFile as unknown as Mock,
    open: mod.open as unknown as Mock,
    access: mod.access as unknown as Mock,
    unlink: mod.unlink as unknown as Mock,
  };
}

async function makeBackend(dataDir = "/data") {
  const { TmuxRuntimeBackend } = await import("../../../src/plugins/tmux/tmux-runtime.js");
  return new TmuxRuntimeBackend({ dataDir });
}

async function makeDockerBackend(dataDir = "/data", workerSessionsDir = "/sessions") {
  const { TmuxRuntimeBackend } = await import("../../../src/plugins/tmux/tmux-runtime.js");
  return new TmuxRuntimeBackend({
    dataDir,
    commandPrefix: ["docker", "exec", "minions-worker"],
    workerSessionsDir,
  });
}

beforeEach(async () => {
  const client = await getMockClientInner();
  client.newSession.mockReset().mockResolvedValue(undefined);
  client.setWindowOption.mockReset().mockResolvedValue(undefined);
  client.pipePane.mockReset().mockResolvedValue(undefined);
  client.pipePaneOff.mockReset().mockResolvedValue(undefined);
  client.waitForSignal.mockReset().mockResolvedValue(undefined);
  client.sessionExists.mockReset().mockResolvedValue(true);
  client.paneDead.mockReset().mockResolvedValue(false);
  client.killSession.mockReset().mockResolvedValue(undefined);

  const fs = await getFsMock();
  fs.mkdir.mockReset().mockResolvedValue(undefined);
  fs.writeFile.mockReset().mockResolvedValue(undefined);
  fs.open.mockReset().mockResolvedValue(mockFileHandle);
  mockFileHandle.stat.mockReset().mockResolvedValue({ size: 0 });
  mockFileHandle.read.mockReset().mockResolvedValue({ bytesRead: 0 });
  mockFileHandle.close.mockReset().mockResolvedValue(undefined);
  const fsp = await import("node:fs/promises");
  (fsp.unlink as unknown as Mock).mockReset().mockResolvedValue(undefined);
  (fsp.access as unknown as Mock).mockReset().mockResolvedValue(undefined);

  const followLog = await getFollowLogMock();
  followLog.mockReset().mockImplementation(async function* () {});

  void mockClient;
});

describe("TmuxRuntimeBackend", () => {
  it("start sequence: newSession → setWindowOption(remain-on-exit, on) → pipePane → waitForSignal", async () => {
    const backend = await makeBackend();
    const client = await getMockClientInner();

    const callOrder: string[] = [];
    client.newSession.mockImplementation(async () => { callOrder.push("newSession"); });
    client.setWindowOption.mockImplementation(async () => { callOrder.push("setWindowOption"); });
    client.pipePane.mockImplementation(async () => { callOrder.push("pipePane"); });
    client.waitForSignal.mockImplementation(async () => { callOrder.push("waitForSignal"); });

    await backend.start({ taskId: "t1", workflowId: "wf-1", command: ["echo"] });

    expect(callOrder).toEqual(["newSession", "setWindowOption", "pipePane", "waitForSignal"]);
    expect(client.setWindowOption).toHaveBeenCalledWith(
      expect.any(String),
      "remain-on-exit",
      "on",
    );
  });

  it("launcher script is written before newSession runs", async () => {
    const backend = await makeBackend();
    const client = await getMockClientInner();
    const fs = await getFsMock();

    const callOrder: string[] = [];
    fs.writeFile.mockImplementation(async () => { callOrder.push("writeFile"); });
    client.newSession.mockImplementation(async () => { callOrder.push("newSession"); });

    await backend.start({ taskId: "t1", workflowId: "wf-1", command: ["echo"] });

    const writeIdx = callOrder.indexOf("writeFile");
    const newSessionIdx = callOrder.indexOf("newSession");
    expect(writeIdx).toBeGreaterThanOrEqual(0);
    expect(newSessionIdx).toBeGreaterThan(writeIdx);
  });

  it("sessionId matches mwf-<slug>-<hash8>-<shortid> pattern", async () => {
    const backend = await makeBackend();
    const result = await backend.start({ taskId: "wf-1:task", workflowId: "wf-1", command: ["echo"] });
    expect(result.sessionId).toMatch(/^mwf-[a-zA-Z0-9_-]+-[a-f0-9]{8}-[a-f0-9]{6}$/);
  });

  it("sanitizes task id: strips colon, keeps valid chars", async () => {
    const backend = await makeBackend();
    const result = await backend.start({ taskId: "wf-1:task", workflowId: "wf-1", command: ["echo"] });
    const parts = result.sessionId.split("-");
    // mwf + slug parts + hash8 + shortid; colon stripped so slug won't contain it
    const slugPart = parts.slice(1, parts.length - 2).join("-");
    expect(slugPart).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(slugPart).not.toContain(":");
  });

  it("two starts with same taskId produce different sessionIds", async () => {
    const backend = await makeBackend();
    const r1 = await backend.start({ taskId: "t1", workflowId: "wf-1", command: ["echo"] });
    const r2 = await backend.start({ taskId: "t1", workflowId: "wf-1", command: ["echo"] });
    expect(r1.sessionId).not.toBe(r2.sessionId);
  });

  it("partial failure: pipePane throws after newSession → killSession is called", async () => {
    const backend = await makeBackend();
    const client = await getMockClientInner();

    client.pipePane.mockRejectedValue(new Error("pipe failed"));

    await expect(
      backend.start({ taskId: "t1", workflowId: "wf-1", command: ["echo"] }),
    ).rejects.toThrow("pipe failed");

    expect(client.killSession).toHaveBeenCalledOnce();
  });

  it("start failure does NOT delete script or log files", async () => {
    const backend = await makeBackend();
    const client = await getMockClientInner();
    const fsp = await import("node:fs/promises");

    client.pipePane.mockRejectedValue(new Error("pipe failed"));

    await expect(
      backend.start({ taskId: "t1", workflowId: "wf-1", command: ["echo"] }),
    ).rejects.toThrow();

    expect(fsp.unlink).not.toHaveBeenCalled();
  });

  it("stop calls killSession and swallows TmuxNoSuchSessionError; does NOT delete log or script", async () => {
    const backend = await makeBackend();
    const client = await getMockClientInner();
    const fsp = await import("node:fs/promises");
    const { TmuxNoSuchSessionError: TNSE } = await import("../../../src/plugins/tmux/tmux-client.js");

    client.killSession.mockRejectedValue(new TNSE("", "no such session", 1));

    await expect(backend.stop("any-session")).resolves.toBeUndefined();
    expect(client.killSession).toHaveBeenCalledWith("any-session");
    expect(fsp.unlink).not.toHaveBeenCalled();
  });

  it("stop propagates non-TmuxNoSuchSession errors and does NOT delete log or script", async () => {
    const backend = await makeBackend();
    const client = await getMockClientInner();
    const fsp = await import("node:fs/promises");
    const { TmuxError } = await import("../../../src/plugins/tmux/tmux-client.js");

    client.killSession.mockRejectedValue(
      new TmuxError("socket error", "", "socket", 1),
    );

    await expect(backend.stop("session")).rejects.toThrow("socket error");
    expect(fsp.unlink).not.toHaveBeenCalled();
  });

  it("probe: sessionExists=false → 'missing'", async () => {
    const backend = await makeBackend();
    const client = await getMockClientInner();
    client.sessionExists.mockResolvedValue(false);

    expect(await backend.probe("x")).toBe("missing");
  });

  it("probe: sessionExists=true, paneDead=true → 'dead'", async () => {
    const backend = await makeBackend();
    const client = await getMockClientInner();
    client.sessionExists.mockResolvedValue(true);
    client.paneDead.mockResolvedValue(true);

    expect(await backend.probe("x")).toBe("dead");
  });

  it("probe: sessionExists=true, paneDead=false → 'live'", async () => {
    const backend = await makeBackend();
    const client = await getMockClientInner();
    client.sessionExists.mockResolvedValue(true);
    client.paneDead.mockResolvedValue(false);

    expect(await backend.probe("x")).toBe("live");
  });

  it("attach propagates fromOffset to followLog and yields RuntimeOutputChunk shape", async () => {
    const backend = await makeBackend();
    const followLog = await getFollowLogMock();

    const fakeBytes = new Uint8Array([1, 2, 3]);
    followLog.mockImplementation(async function* (
      _path: string,
      fromOffset: number,
    ) {
      yield { offset: fromOffset, bytes: fakeBytes };
    });

    const chunks: RuntimeOutputChunk[] = [];
    for await (const chunk of backend.attach("my-session", { fromOffset: 42 })) {
      chunks.push(chunk);
    }

    expect(followLog).toHaveBeenCalledWith(
      expect.stringContaining("my-session.log"),
      42,
      expect.any(AbortSignal),
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ sessionId: "my-session", offset: 42 });
  });

  it("attach on missing log file yields nothing without exception", async () => {
    const backend = await makeBackend();
    const followLog = await getFollowLogMock();
    followLog.mockImplementation(async function* () {});

    const chunks: RuntimeOutputChunk[] = [];
    for await (const chunk of backend.attach("no-log-session")) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(0);
  });

  it("start rejects empty command before touching filesystem", async () => {
    const backend = await makeBackend();
    const fs = await getFsMock();

    await expect(
      backend.start({ taskId: "t1", workflowId: "wf-1", command: [] }),
    ).rejects.toThrow("command must be non-empty");

    expect(fs.mkdir).not.toHaveBeenCalled();
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it("start rejects whitespace-only command before touching filesystem", async () => {
    const backend = await makeBackend();
    const fs = await getFsMock();

    await expect(
      backend.start({ taskId: "t1", workflowId: "wf-1", command: ["  ", "\t"] }),
    ).rejects.toThrow("command must be non-empty");

    expect(fs.mkdir).not.toHaveBeenCalled();
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it("stop calls pipePaneOff before killSession", async () => {
    const backend = await makeBackend();
    const client = await getMockClientInner();

    const callOrder: string[] = [];
    client.pipePaneOff.mockImplementation(async () => { callOrder.push("pipePaneOff"); });
    client.killSession.mockImplementation(async () => { callOrder.push("killSession"); });

    await backend.stop("some-session");

    expect(callOrder).toEqual(["pipePaneOff", "killSession"]);
  });

  it("stop swallows TmuxNoSuchSessionError from pipePaneOff", async () => {
    const backend = await makeBackend();
    const client = await getMockClientInner();
    const { TmuxNoSuchSessionError: TNSE } = await import("../../../src/plugins/tmux/tmux-client.js");

    client.pipePaneOff.mockRejectedValue(new TNSE("", "no such session", 1));

    await expect(backend.stop("gone-session")).resolves.toBeUndefined();
    expect(client.killSession).toHaveBeenCalledWith("gone-session");
  });

  it("stop swallows docker-down TmuxError from pipePaneOff", async () => {
    const backend = await makeDockerBackend();
    const client = await getMockClientInner();
    const { TmuxError: TE } = await import("../../../src/plugins/tmux/tmux-client.js");

    client.pipePaneOff.mockRejectedValue(
      new TE("tmux exited with code 1", "", "Error response from daemon: is not running", 1),
    );

    await expect(backend.stop("docker-down-session")).resolves.toBeUndefined();
    expect(client.killSession).toHaveBeenCalledWith("docker-down-session");
  });

  it("stop swallows docker-down TmuxError from killSession", async () => {
    const backend = await makeDockerBackend();
    const client = await getMockClientInner();
    const { TmuxError: TE } = await import("../../../src/plugins/tmux/tmux-client.js");

    client.killSession.mockRejectedValue(
      new TE("tmux exited with code 1", "", "No such container: minions-worker", 1),
    );

    await expect(backend.stop("docker-down-session")).resolves.toBeUndefined();
  });

  it("attach terminates after paneDead returns true and invokes pipePaneOff", async () => {
    const backend = await makeBackend();
    const client = await getMockClientInner();
    const followLog = await getFollowLogMock();

    followLog.mockImplementation(async function* (_path: string, _offset: number, signal: AbortSignal) {
      await new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }));
    });

    client.paneDead.mockResolvedValue(true);

    const chunks: RuntimeOutputChunk[] = [];
    for await (const chunk of backend.attach("dead-session", { fromOffset: 0 })) {
      chunks.push(chunk);
    }

    expect(client.pipePaneOff).toHaveBeenCalledWith("dead-session");
    expect(chunks).toHaveLength(0);
  });

  it("attach final-drain reads trailing bytes after pane death", async () => {
    const backend = await makeBackend();
    const client = await getMockClientInner();
    const followLog = await getFollowLogMock();
    const fs = await getFsMock();

    followLog.mockImplementation(async function* (_path: string, _offset: number, signal: AbortSignal) {
      await new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }));
    });

    client.paneDead.mockResolvedValue(true);

    const tailBytes = Buffer.from("tail-data");
    fs.open.mockResolvedValue({
      stat: vi.fn().mockResolvedValue({ size: tailBytes.length }),
      read: vi.fn().mockImplementation(async (buf: Buffer, _offset: number, length: number) => {
        tailBytes.copy(buf, 0, 0, length);
        return { bytesRead: tailBytes.length };
      }),
      close: vi.fn().mockResolvedValue(undefined),
    });

    const chunks: RuntimeOutputChunk[] = [];
    for await (const chunk of backend.attach("dead-session", { fromOffset: 0 })) {
      chunks.push(chunk);
    }

    const combined = Buffer.concat(chunks.map((c) => Buffer.from(c.bytes))).toString();
    expect(combined).toBe("tail-data");
  });

  it("attach swallows TmuxNoSuchSessionError from paneDead probe and treats as terminated", async () => {
    const backend = await makeBackend();
    const client = await getMockClientInner();
    const followLog = await getFollowLogMock();
    const { TmuxNoSuchSessionError: TNSE } = await import("../../../src/plugins/tmux/tmux-client.js");

    followLog.mockImplementation(async function* (_path: string, _offset: number, signal: AbortSignal) {
      await new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }));
    });

    client.paneDead.mockRejectedValue(new TNSE("", "no such session", 1));

    const chunks: RuntimeOutputChunk[] = [];
    for await (const chunk of backend.attach("gone-session", { fromOffset: 0 })) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(0);
  });

  it("start rejects command with empty argv0 but non-empty args before touching filesystem", async () => {
    const backend = await makeBackend();
    const fs = await getFsMock();

    await expect(
      backend.start({ taskId: "t1", workflowId: "wf-1", command: ["", "foo"] }),
    ).rejects.toThrow("command must be non-empty");

    expect(fs.mkdir).not.toHaveBeenCalled();
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it("attach final-drain polls for .done sentinel before reading", async () => {
    const backend = await makeBackend();
    const client = await getMockClientInner();
    const followLog = await getFollowLogMock();
    const fs = await getFsMock();

    followLog.mockImplementation(async function* (_path: string, _offset: number, signal: AbortSignal) {
      await new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }));
    });

    client.paneDead.mockResolvedValue(true);

    const tailBytes = Buffer.from("sentinel-tail");
    let sentinelCallCount = 0;
    fs.access.mockImplementation(async () => {
      sentinelCallCount += 1;
      if (sentinelCallCount < 3) throw new Error("ENOENT");
    });

    fs.open.mockResolvedValue({
      stat: vi.fn().mockResolvedValue({ size: tailBytes.length }),
      read: vi.fn().mockImplementation(async (buf: Buffer, _off: number, len: number) => {
        tailBytes.copy(buf, 0, 0, len);
        return { bytesRead: tailBytes.length };
      }),
      close: vi.fn().mockResolvedValue(undefined),
    });

    const chunks: RuntimeOutputChunk[] = [];
    for await (const chunk of backend.attach("polled-session", { fromOffset: 0 })) {
      chunks.push(chunk);
    }

    expect(sentinelCallCount).toBeGreaterThanOrEqual(3);
    const combined = Buffer.concat(chunks.map((c) => Buffer.from(c.bytes))).toString();
    expect(combined).toBe("sentinel-tail");
  });

  it("attach final-drain proceeds and reads after sentinel cap timeout when .done never appears", async () => {
    const backend = await makeBackend();
    const client = await getMockClientInner();
    const followLog = await getFollowLogMock();
    const fs = await getFsMock();

    followLog.mockImplementation(async function* (_path: string, _offset: number, signal: AbortSignal) {
      await new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }));
    });

    client.paneDead.mockResolvedValue(true);

    // sentinel never appears
    fs.access.mockRejectedValue(new Error("ENOENT"));

    const capBytes = Buffer.from("cap-tail");
    fs.open.mockResolvedValue({
      stat: vi.fn().mockResolvedValue({ size: capBytes.length }),
      read: vi.fn().mockImplementation(async (buf: Buffer, _off: number, len: number) => {
        capBytes.copy(buf, 0, 0, len);
        return { bytesRead: capBytes.length };
      }),
      close: vi.fn().mockResolvedValue(undefined),
    });

    const chunks: RuntimeOutputChunk[] = [];
    for await (const chunk of backend.attach("cap-session", { fromOffset: 0 })) {
      chunks.push(chunk);
    }

    const combined = Buffer.concat(chunks.map((c) => Buffer.from(c.bytes))).toString();
    expect(combined).toBe("cap-tail");
  }, 2000);

  it("attach final-drain deletes .done sentinel after reading", async () => {
    const backend = await makeBackend();
    const client = await getMockClientInner();
    const followLog = await getFollowLogMock();
    const fs = await getFsMock();

    followLog.mockImplementation(async function* (_path: string, _offset: number, signal: AbortSignal) {
      await new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }));
    });

    client.paneDead.mockResolvedValue(true);
    fs.access.mockResolvedValue(undefined);

    for await (const _chunk of backend.attach("cleanup-session", { fromOffset: 0 })) {
      // no-op
    }

    const fsp = await import("node:fs/promises");
    const unlinkMock = fsp.unlink as unknown as Mock;
    expect(unlinkMock).toHaveBeenCalledWith(
      expect.stringContaining("cleanup-session.log.done"),
    );
  });
});

describe("TmuxRuntimeBackend (docker mode)", () => {
  it("workerSessionsDir translates newSession and pipePane paths to worker-POV", async () => {
    const backend = await makeDockerBackend("/data", "/sessions");
    const client = await getMockClientInner();

    await backend.start({ taskId: "t1", workflowId: "wf-1", command: ["echo"] });

    const sessionCall = client.newSession.mock.calls[0] as [{ name: string; scriptPath: string }];
    expect(sessionCall[0].scriptPath).toMatch(/^\/sessions\/.+\.sh$/);

    const pipeCall = client.pipePane.mock.calls[0] as [string, string];
    expect(pipeCall[1]).toMatch(/^\/sessions\/.+\.log$/);
  });

  it("host-POV paths (mkdir, writeFile) use dataDir, not workerSessionsDir", async () => {
    const backend = await makeDockerBackend("/data", "/sessions");
    const fs = await getFsMock();

    await backend.start({ taskId: "t1", workflowId: "wf-1", command: ["echo"] });

    expect(fs.mkdir).toHaveBeenCalledWith(expect.stringContaining("/data/sessions"), expect.anything());
    const writeFileCalls = (fs.writeFile.mock.calls as [string, ...unknown[]][]).map((c) => c[0]);
    expect(writeFileCalls.some((p) => p.startsWith("/data/sessions"))).toBe(true);
    expect(writeFileCalls.every((p) => !p.startsWith("/sessions/"))).toBe(true);
  });

  it("container-down: probe returns 'missing' when commandPrefix is set and stderr matches DOCKER_DOWN_RE", async () => {
    const backend = await makeDockerBackend();
    const client = await getMockClientInner();
    const { TmuxError: TE } = await import("../../../src/plugins/tmux/tmux-client.js");

    client.sessionExists.mockRejectedValue(
      new TE("tmux exited with code 1", "", "Error response from daemon: No such container: minions-worker", 1),
    );

    expect(await backend.probe("any-session")).toBe("missing");
  });

  it("container-down: start rethrows when container is stopped", async () => {
    const backend = await makeDockerBackend();
    const client = await getMockClientInner();
    const { TmuxError: TE } = await import("../../../src/plugins/tmux/tmux-client.js");

    const dockerError = new TE("tmux exited with code 1", "", "Error response from daemon: is not running", 1);
    client.newSession.mockRejectedValue(dockerError);

    await expect(
      backend.start({ taskId: "t1", workflowId: "wf-1", command: ["echo"] }),
    ).rejects.toThrow(dockerError);
  });

  it("non-docker TmuxError in probe rethrows even when commandPrefix is set", async () => {
    const backend = await makeDockerBackend();
    const client = await getMockClientInner();
    const { TmuxError: TE } = await import("../../../src/plugins/tmux/tmux-client.js");

    const socketError = new TE("tmux exited with code 1", "", "socket error unrelated to docker", 1);
    client.sessionExists.mockRejectedValue(socketError);

    await expect(backend.probe("any-session")).rejects.toThrow(socketError);
  });

  it("default workerSessionsDir equals dataDir/sessions (local-mode regression)", async () => {
    const { TmuxRuntimeBackend } = await import("../../../src/plugins/tmux/tmux-runtime.js");
    const backend = new TmuxRuntimeBackend({ dataDir: "/mydata" });
    const client = await getMockClientInner();

    await backend.start({ taskId: "t1", workflowId: "wf-1", command: ["echo"] });

    const sessionCall = client.newSession.mock.calls[0] as [{ name: string; scriptPath: string }];
    expect(sessionCall[0].scriptPath).toMatch(/^\/mydata\/sessions\/.+\.sh$/);
  });

  it("container-down: probe returns 'missing' when paneDead throws docker-down (sessionExists succeeded)", async () => {
    const backend = await makeDockerBackend();
    const client = await getMockClientInner();
    const { TmuxError: TE } = await import("../../../src/plugins/tmux/tmux-client.js");

    client.sessionExists.mockResolvedValue(true);
    client.paneDead.mockRejectedValue(
      new TE("tmux exited with code 1", "", "Error response from daemon: is not running", 1),
    );

    expect(await backend.probe("any-session")).toBe("missing");
  });

  it("container-down: attach final-drain swallows docker-down from pipePaneOff", async () => {
    const backend = await makeDockerBackend();
    const client = await getMockClientInner();
    const followLog = await getFollowLogMock();
    const { TmuxError: TE } = await import("../../../src/plugins/tmux/tmux-client.js");

    followLog.mockImplementation(async function* (_path: string, _offset: number, signal: AbortSignal) {
      await new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }));
    });

    client.paneDead.mockResolvedValue(true);
    client.pipePaneOff.mockRejectedValue(
      new TE("tmux exited with code 1", "", "Error response from daemon: is not running", 1),
    );

    const chunks: RuntimeOutputChunk[] = [];
    await expect(async () => {
      for await (const chunk of backend.attach("docker-drain-session", { fromOffset: 0 })) {
        chunks.push(chunk);
      }
    }).not.toThrow();
  });

  it("container-down: attach poller terminates and aborts when paneDead throws docker-down", async () => {
    const backend = await makeDockerBackend();
    const client = await getMockClientInner();
    const followLog = await getFollowLogMock();
    const { TmuxError: TE } = await import("../../../src/plugins/tmux/tmux-client.js");

    followLog.mockImplementation(async function* (_path: string, _offset: number, signal: AbortSignal) {
      await new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }));
    });

    client.paneDead.mockRejectedValue(
      new TE("tmux exited with code 1", "", "Error response from daemon: No such container: minions-worker", 1),
    );

    const chunks: RuntimeOutputChunk[] = [];
    for await (const chunk of backend.attach("docker-down-session", { fromOffset: 0 })) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(0);
    expect(client.pipePaneOff).toHaveBeenCalledWith("docker-down-session");
  });

  it("generic daemon error that is NOT container-down does not match isDockerDown — probe rethrows", async () => {
    const backend = await makeDockerBackend();
    const client = await getMockClientInner();
    const { TmuxError: TE } = await import("../../../src/plugins/tmux/tmux-client.js");

    const daemonError = new TE(
      "tmux exited with code 1",
      "",
      "Error response from daemon: pull access denied for private-image",
      1,
    );
    client.sessionExists.mockRejectedValue(daemonError);

    await expect(backend.probe("any-session")).rejects.toThrow(daemonError);
  });

  it("paused container error does NOT match isDockerDown — probe rethrows the TmuxError", async () => {
    const backend = await makeDockerBackend();
    const client = await getMockClientInner();
    const { TmuxError: TE } = await import("../../../src/plugins/tmux/tmux-client.js");

    const pausedError = new TE(
      "tmux exited with code 1",
      "",
      "Error response from daemon: Container abc123 is paused, unpause the container before exec",
      1,
    );
    client.sessionExists.mockRejectedValue(pausedError);

    await expect(backend.probe("paused-session")).rejects.toThrow(pausedError);
  });
});
