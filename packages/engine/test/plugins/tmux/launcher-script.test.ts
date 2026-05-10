import { describe, expect, it } from "vitest";
import {
  buildLauncherScript,
  quoteShellArg,
} from "../../../src/plugins/tmux/launcher-script.js";

describe("quoteShellArg", () => {
  it("wraps plain strings in single quotes", () => {
    expect(quoteShellArg("hello")).toBe("'hello'");
  });

  it("escapes single quotes via sentinel", () => {
    expect(quoteShellArg("it's")).toBe("'it'\\''s'");
  });

  it("handles dollar signs, semicolons, backticks, spaces", () => {
    const s = "$VAR ; `cmd` with spaces";
    const quoted = quoteShellArg(s);
    expect(quoted).toBe("'$VAR ; `cmd` with spaces'");
  });
});

describe("buildLauncherScript", () => {
  it("starts with #!/bin/sh", () => {
    const script = buildLauncherScript({
      command: ["echo"],
      socketName: "minions",
      releaseToken: "release-token",
    });
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
  });

  it("ends with a newline", () => {
    const script = buildLauncherScript({
      command: ["echo"],
      socketName: "minions",
      releaseToken: "release-token",
    });
    expect(script.endsWith("\n")).toBe(true);
  });

  it("omits cd line when cwd is not set", () => {
    const script = buildLauncherScript({
      command: ["echo"],
      socketName: "minions",
      releaseToken: "release-token",
    });
    expect(script).not.toContain("cd ");
  });

  it("emits cd line with quoted path when cwd is set", () => {
    const script = buildLauncherScript({
      command: ["echo"],
      socketName: "minions",
      releaseToken: "release-token",
      cwd: "/some/work dir",
    });
    expect(script).toContain("cd '/some/work dir'");
  });

  it("cd line fails fast when the directory is invalid", () => {
    const script = buildLauncherScript({
      command: ["echo"],
      socketName: "minions",
      releaseToken: "release-token",
      cwd: "/some/work dir",
    });
    expect(script).toContain("cd '/some/work dir' || exit $?");
  });

  it("rejects malformed env var names", () => {
    expect(() =>
      buildLauncherScript({
        command: ["echo"],
        socketName: "minions",
        releaseToken: "release-token",
        env: { "BAD;NAME": "value" },
      }),
    ).toThrow(/invalid env var name/);
  });

  it("rejects env var names starting with a digit", () => {
    expect(() =>
      buildLauncherScript({
        command: ["echo"],
        socketName: "minions",
        releaseToken: "release-token",
        env: { "1FOO": "value" },
      }),
    ).toThrow(/invalid env var name/);
  });

  it("omits export lines when env is not set", () => {
    const script = buildLauncherScript({
      command: ["echo"],
      socketName: "minions",
      releaseToken: "release-token",
    });
    expect(script).not.toContain("export ");
  });

  it("emits export lines with quoted values when env is set", () => {
    const script = buildLauncherScript({
      command: ["echo"],
      socketName: "minions",
      releaseToken: "release-token",
      env: { FOO: "bar baz", KEY: "it's value" },
    });
    expect(script).toContain("export FOO='bar baz'");
    expect(script).toContain("export KEY='it'\\''s value'");
  });

  it("wait-for line precedes exec line", () => {
    const script = buildLauncherScript({
      command: ["echo", "hello"],
      socketName: "minions",
      releaseToken: "release-tok",
    });
    const waitIdx = script.indexOf("wait-for");
    const execIdx = script.indexOf("exec ");
    expect(waitIdx).toBeLessThan(execIdx);
  });

  it("wait-for line precedes cd so cd-failure does not strand the engine on an unsignaled wait-for", () => {
    const script = buildLauncherScript({
      command: ["echo"],
      socketName: "minions",
      releaseToken: "tok",
      cwd: "/nonexistent",
    });
    const waitIdx = script.indexOf("wait-for");
    const cdIdx = script.indexOf("cd ");
    expect(waitIdx).toBeLessThan(cdIdx);
  });

  it("wait-for line uses socketName and releaseToken", () => {
    const script = buildLauncherScript({
      command: ["echo"],
      socketName: "test-socket",
      releaseToken: "my-release-token",
    });
    expect(script).toContain("-L 'test-socket' wait-for 'my-release-token'");
  });

  it("exec line quotes argv with spaces and special chars independently", () => {
    const script = buildLauncherScript({
      command: ["sh", "-c", "echo 'hello world'"],
      socketName: "minions",
      releaseToken: "tok",
    });
    expect(script).toContain("exec 'sh' '-c' 'echo '\\''hello world'\\'''");
  });

  it("honors custom tmuxBin in wait-for line", () => {
    const script = buildLauncherScript({
      command: ["echo"],
      socketName: "minions",
      releaseToken: "tok",
      tmuxBin: "/usr/local/bin/tmux",
    });
    expect(script).toContain("'/usr/local/bin/tmux' -L 'minions' wait-for 'tok'");
  });
});
