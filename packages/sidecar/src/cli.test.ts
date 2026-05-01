import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runSidecar } from "./cli.js";
import { createLogger } from "./log.js";

function silentLogger() {
  return createLogger("error", { service: "sidecar-test" });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("runSidecar", () => {
  it("writes pidfile + heartbeat on startup, updates heartbeat on tick, cleans up on shutdown", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-cli-"));
    const pidFile = path.join(workspace, ".sidecar.pid");
    const heartbeatFile = path.join(workspace, ".sidecar.heartbeat");

    const runtime = runSidecar({
      baseUrl: "http://127.0.0.1:1",
      token: "test-token",
      workspace,
      rules: ["all"],
      log: silentLogger(),
      heartbeatIntervalMs: 50,
    });

    try {
      assert.ok(fs.existsSync(pidFile), "pidfile should exist after startup");
      assert.equal(fs.readFileSync(pidFile, "utf8").trim(), String(process.pid));

      assert.ok(fs.existsSync(heartbeatFile), "heartbeat file should exist after startup");
      const firstBeat = fs.readFileSync(heartbeatFile, "utf8").trim();
      assert.ok(!Number.isNaN(Date.parse(firstBeat)), "heartbeat should be ISO8601");

      await delay(150);

      const secondBeat = fs.readFileSync(heartbeatFile, "utf8").trim();
      assert.notEqual(secondBeat, firstBeat, "heartbeat should advance after interval");
      assert.ok(Date.parse(secondBeat) > Date.parse(firstBeat));
    } finally {
      await runtime.shutdown("test");
      fs.rmSync(workspace, { recursive: true, force: true });
    }

    assert.equal(fs.existsSync(pidFile), false, "pidfile should be unlinked on shutdown");
  });

  it("throws when no rules match", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-cli-"));
    try {
      assert.throws(
        () =>
          runSidecar({
            baseUrl: "http://127.0.0.1:1",
            token: "test-token",
            workspace,
            rules: ["does-not-exist"],
            log: silentLogger(),
            heartbeatIntervalMs: 50,
          }),
        /no rules selected/,
      );
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
