import { EventEmitter } from "node:events";
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TmuxClient,
  TmuxError,
  TmuxNoSuchSessionError,
} from "../../../src/plugins/tmux/tmux-client.js";

vi.mock("node:child_process");

interface MockProc extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
}

function makeMockProc(
  stdoutData: string,
  stderrData: string,
  exitCode: number,
): MockProc {
  const proc = new EventEmitter() as MockProc;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();

  setImmediate(() => {
    proc.stdout.emit("data", Buffer.from(stdoutData));
    proc.stderr.emit("data", Buffer.from(stderrData));
    proc.emit("close", exitCode);
  });

  return proc;
}

let spawnMock: Mock;

beforeEach(async () => {
  const cp = await import("node:child_process");
  spawnMock = cp.spawn as unknown as Mock;
  spawnMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("TmuxClient", () => {
  const client = new TmuxClient({ socketName: "minions" });

  it("newSession shell-quotes scriptPath so paths with spaces or metachars survive tmux's parser", async () => {
    spawnMock.mockReturnValue(makeMockProc("", "", 0));
    await client.newSession({ name: "mwf-task-abc-123456", scriptPath: "/tmp/with space/s.sh" });

    expect(spawnMock).toHaveBeenCalledWith(
      "tmux",
      ["-L", "minions", "new-session", "-d", "-s", "mwf-task-abc-123456", "'/tmp/with space/s.sh'"],
    );
  });

  it("setWindowOption constructs correct argv", async () => {
    spawnMock.mockReturnValue(makeMockProc("", "", 0));
    await client.setWindowOption("mwf-task-abc-123456", "remain-on-exit", "on");

    expect(spawnMock).toHaveBeenCalledWith(
      "tmux",
      ["-L", "minions", "set-window-option", "-t", "mwf-task-abc-123456", "remain-on-exit", "on"],
    );
  });

  it("pipePane shell-quotes the log path and appends sentinel touch", async () => {
    spawnMock.mockReturnValue(makeMockProc("", "", 0));
    await client.pipePane("mwf-task-abc-123456", "/tmp/log file's path.log");

    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    const oArg = args[args.indexOf("-o") + 1];
    expect(oArg).toBe("cat >> '/tmp/log file'\\''s path.log'; touch '/tmp/log file'\\''s path.log.done'");
  });

  it("pipePane sentinel path is log path with .done suffix", async () => {
    spawnMock.mockReturnValue(makeMockProc("", "", 0));
    await client.pipePane("session", "/data/sessions/mwf-task.log");

    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    const oArg = args[args.indexOf("-o") + 1];
    expect(oArg).toBe("cat >> '/data/sessions/mwf-task.log'; touch '/data/sessions/mwf-task.log.done'");
  });

  it("waitForSignal constructs correct argv", async () => {
    spawnMock.mockReturnValue(makeMockProc("", "", 0));
    await client.waitForSignal("release-mwf-task-abc-123456");

    expect(spawnMock).toHaveBeenCalledWith(
      "tmux",
      ["-L", "minions", "wait-for", "-S", "release-mwf-task-abc-123456"],
    );
  });

  it("sessionExists returns true on exit 0, false on no-such-session", async () => {
    spawnMock.mockReturnValueOnce(makeMockProc("", "", 0));
    expect(await client.sessionExists("mwf-task-abc-123456")).toBe(true);

    spawnMock.mockReturnValueOnce(makeMockProc("", "no such session", 1));
    expect(await client.sessionExists("mwf-task-abc-123456")).toBe(false);
  });

  it("paneDead returns true for stdout '1', false for '0'", async () => {
    spawnMock.mockReturnValueOnce(makeMockProc("1\n", "", 0));
    expect(await client.paneDead("mwf-task-abc-123456")).toBe(true);

    spawnMock.mockReturnValueOnce(makeMockProc("0\n", "", 0));
    expect(await client.paneDead("mwf-task-abc-123456")).toBe(false);
  });

  it("killSession maps no-such-session stderr to TmuxNoSuchSessionError", async () => {
    spawnMock.mockReturnValue(makeMockProc("", "no such session", 1));
    await expect(client.killSession("gone-session")).rejects.toThrow(TmuxNoSuchSessionError);
  });

  it("non-zero exit without known pattern throws TmuxError with stdout/stderr/exitCode", async () => {
    spawnMock.mockReturnValue(makeMockProc("out", "some error", 2));
    const err = await client.killSession("x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TmuxError);
    expect(err).not.toBeInstanceOf(TmuxNoSuchSessionError);
    const tmuxErr = err as TmuxError;
    expect(tmuxErr.stdout).toBe("out");
    expect(tmuxErr.stderr).toBe("some error");
    expect(tmuxErr.exitCode).toBe(2);
  });

  it("custom tmuxBin config is honored in argv", async () => {
    const custom = new TmuxClient({ socketName: "minions", tmuxBin: "/usr/local/bin/tmux" });
    spawnMock.mockReturnValue(makeMockProc("", "", 0));
    await custom.waitForSignal("token");

    expect(spawnMock).toHaveBeenCalledWith(
      "/usr/local/bin/tmux",
      expect.arrayContaining(["-L", "minions", "wait-for", "-S", "token"]),
    );
  });

  it("pipePaneOff sends pipe-pane -t <name> with no additional args", async () => {
    spawnMock.mockReturnValue(makeMockProc("", "", 0));
    await client.pipePaneOff("mwf-task-abc-123456");

    expect(spawnMock).toHaveBeenCalledWith(
      "tmux",
      ["-L", "minions", "pipe-pane", "-t", "mwf-task-abc-123456"],
    );
  });

  it("pipePaneOff maps no-such-session stderr to TmuxNoSuchSessionError", async () => {
    spawnMock.mockReturnValue(makeMockProc("", "no such session", 1));
    await expect(client.pipePaneOff("gone-session")).rejects.toThrow(TmuxNoSuchSessionError);
  });

  describe("commandPrefix", () => {
    it("commandPrefix produces argv [prefix..., tmuxBin, '-L', socket, ...args]", async () => {
      const prefixed = new TmuxClient({
        socketName: "minions",
        commandPrefix: ["docker", "exec", "minions-worker"],
      });
      spawnMock.mockReturnValue(makeMockProc("", "", 0));
      await prefixed.waitForSignal("release-x");

      expect(spawnMock).toHaveBeenCalledWith(
        "docker",
        ["exec", "minions-worker", "tmux", "-L", "minions", "wait-for", "-S", "release-x"],
      );
    });

    it("empty commandPrefix uses unprefixed argv (regression)", async () => {
      const noPrefix = new TmuxClient({ socketName: "minions", commandPrefix: [] });
      spawnMock.mockReturnValue(makeMockProc("", "", 0));
      await noPrefix.waitForSignal("token");

      expect(spawnMock).toHaveBeenCalledWith(
        "tmux",
        ["-L", "minions", "wait-for", "-S", "token"],
      );
    });

    it("absent commandPrefix uses unprefixed argv (regression)", async () => {
      const noPrefix = new TmuxClient({ socketName: "minions" });
      spawnMock.mockReturnValue(makeMockProc("", "", 0));
      await noPrefix.waitForSignal("token");

      expect(spawnMock).toHaveBeenCalledWith(
        "tmux",
        ["-L", "minions", "wait-for", "-S", "token"],
      );
    });

    it("commandPrefix + custom tmuxBin places tmuxBin after prefix, not before", async () => {
      const prefixed = new TmuxClient({
        socketName: "minions",
        tmuxBin: "/usr/local/bin/tmux",
        commandPrefix: ["docker", "exec", "minions-worker"],
      });
      spawnMock.mockReturnValue(makeMockProc("", "", 0));
      await prefixed.waitForSignal("tok");

      expect(spawnMock).toHaveBeenCalledWith(
        "docker",
        ["exec", "minions-worker", "/usr/local/bin/tmux", "-L", "minions", "wait-for", "-S", "tok"],
      );
    });
  });
});
