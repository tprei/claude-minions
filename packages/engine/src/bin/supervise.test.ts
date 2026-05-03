import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nextDelayMs } from "./supervise.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SUPERVISE_TS = path.join(here, "supervise.ts");
const ENGINE_PKG = path.resolve(here, "..", "..");
const TSX_BIN = path.join(ENGINE_PKG, "node_modules", ".bin", "tsx");

const roots: string[] = [];

function makeRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minions-supervise-"));
  roots.push(dir);
  return dir;
}

after(() => {
  for (const r of roots) {
    fs.rmSync(r, { recursive: true, force: true });
  }
});

describe("supervise", () => {
  describe("nextDelayMs", () => {
    const schedule = [2000, 5000, 15000, 30000, 60000];
    const windowMs = 5 * 60_000;

    test("empty history -> first slot", () => {
      const now = 1_000_000;
      const r = nextDelayMs([], now, schedule, windowMs);
      assert.equal(r.delay, 2000);
      assert.equal(r.index, 0);
    });

    test("walks the schedule with consecutive crashes", () => {
      const now = 1_000_000;
      assert.equal(nextDelayMs([now - 1000], now, schedule, windowMs).delay, 5000);
      assert.equal(nextDelayMs([now - 2000, now - 1000], now, schedule, windowMs).delay, 15000);
      assert.equal(
        nextDelayMs([now - 3000, now - 2000, now - 1000], now, schedule, windowMs).delay,
        30000,
      );
      assert.equal(
        nextDelayMs([now - 4000, now - 3000, now - 2000, now - 1000], now, schedule, windowMs).delay,
        60000,
      );
    });

    test("clamps at the last slot beyond schedule length", () => {
      const now = 1_000_000;
      const history = [now - 5000, now - 4000, now - 3000, now - 2000, now - 1000];
      const r = nextDelayMs(history, now, schedule, windowMs);
      assert.equal(r.delay, 60000);
      assert.equal(r.index, schedule.length - 1);
    });

    test("history older than window resets to first slot", () => {
      const now = 10_000_000;
      const history = [now - windowMs - 1, now - windowMs - 100, now - windowMs - 200];
      const r = nextDelayMs(history, now, schedule, windowMs);
      assert.equal(r.delay, 2000);
      assert.equal(r.index, 0);
    });

    test("only in-window crashes count when history is mixed", () => {
      const now = 10_000_000;
      const history = [
        now - windowMs - 5000,
        now - windowMs - 4000,
        now - windowMs - 3000,
        now - 2000,
        now - 1000,
      ];
      const r = nextDelayMs(history, now, schedule, windowMs);
      assert.equal(r.delay, 15000);
      assert.equal(r.index, 2);
    });
  });

  describe("integration", () => {
    test("respawns crashing child, writes crash logs, and rotates engine.log entries", { timeout: 30_000 }, async () => {
      const root = makeRoot();
      const logDir = path.join(root, "logs");
      const crashDir = path.join(root, "crashes");
      const counterFile = path.join(root, "counter");
      fs.writeFileSync(counterFile, "0");

      const fakeScript = path.join(root, "fake-engine.sh");
      fs.writeFileSync(
        fakeScript,
        `#!/usr/bin/env bash
set -e
COUNTER_FILE="${counterFile}"
N=$(cat "$COUNTER_FILE")
N=$((N + 1))
echo "$N" > "$COUNTER_FILE"
if [ "$N" -le 3 ]; then
  echo "crash run #$N"
  exit 1
else
  echo "clean run"
  exit 0
fi
`,
        { mode: 0o755 },
      );

      const env = {
        ...process.env,
        MINIONS_LOG_DIR: logDir,
        MINIONS_CRASH_LOG_DIR: crashDir,
        MINIONS_ENGINE_CMD: `bash ${fakeScript}`,
        MINIONS_SUPERVISE_BACKOFF_MS_OVERRIDE: "100,200,400",
      };

      const child = spawn(TSX_BIN, [SUPERVISE_TS], { env, stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stderr?.on("data", (b: Buffer) => {
        stderr += b.toString("utf8");
      });
      let stdout = "";
      child.stdout?.on("data", (b: Buffer) => {
        stdout += b.toString("utf8");
      });

      const exitInfo = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          const t = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`supervisor timed out\nstderr:\n${stderr}\nstdout:\n${stdout}`));
          }, 10_000);
          child.once("exit", (code, signal) => {
            clearTimeout(t);
            resolve({ code, signal });
          });
        },
      );

      assert.equal(exitInfo.code, 0, `expected exit 0, got ${exitInfo.code}, stderr:\n${stderr}`);

      const counter = fs.readFileSync(counterFile, "utf8").trim();
      assert.equal(counter, "4", "fake engine ran 4 times (3 crashes + 1 clean)");

      const crashFileNames = fs
        .readdirSync(crashDir)
        .filter((f) => f.endsWith(".log"));
      assert.equal(
        crashFileNames.length,
        3,
        `expected 3 crash files, got ${crashFileNames.length}: ${crashFileNames.join(",")}`,
      );

      // Sort by the monotonic restartCount in the JSON header, not the filename:
      // filenames embed wall-clock timestamps which can skew (notably under WSL2 load).
      const crashEntries = crashFileNames.map((name) => {
        const body = fs.readFileSync(path.join(crashDir, name), "utf8");
        const firstLine = body.split("\n", 1)[0]!;
        const header = JSON.parse(firstLine) as Record<string, unknown>;
        return { name, body, header };
      });
      crashEntries.sort(
        (a, b) => (a.header.restartCount as number) - (b.header.restartCount as number),
      );

      for (let i = 0; i < crashEntries.length; i++) {
        const { body, header } = crashEntries[i]!;
        assert.equal(header.event, "child_crash");
        assert.equal(typeof header.nextDelayMs, "number");
        assert.equal(header.restartCount, i + 1);
        assert.ok(
          body.includes(`crash run #${i + 1}`),
          `crash log ${i + 1} should mention run #${i + 1}`,
        );
      }

      const enginePath = path.join(logDir, "engine.log");
      assert.equal(fs.existsSync(enginePath), true, "engine.log exists");
      const engineLog = fs.readFileSync(enginePath, "utf8");
      assert.ok(engineLog.includes("crash run #1"), "engine.log contains crash run #1");
      assert.ok(engineLog.includes("clean run"), "engine.log contains clean run");

      const stderrEvents = stderr
        .split("\n")
        .filter((l) => l.trim().startsWith("{"))
        .map((l) => JSON.parse(l) as { event: string; ts: string; nextDelayMs?: number });

      const crashEvents = stderrEvents.filter((e) => e.event === "child_crash");
      const spawnEvents = stderrEvents.filter((e) => e.event === "child_spawn");
      assert.equal(crashEvents.length, 3, "three child_crash events on stderr");
      assert.equal(spawnEvents.length, 4, "four child_spawn events on stderr");
      assert.deepEqual(
        crashEvents.map((e) => e.nextDelayMs),
        [100, 200, 400],
      );
      // The actual sleep uses setTimeout (monotonic clock), and the configured
      // backoff is already asserted above via nextDelayMs. We avoid asserting
      // on Date.parse(event.ts) deltas because the wall clock can skew (notably
      // under WSL2 / virtualized hosts) and produce negative differences here.
    });

    test("forwards SIGTERM to the child for graceful shutdown", { timeout: 15_000 }, async () => {
      const root = makeRoot();
      const logDir = path.join(root, "logs");
      const crashDir = path.join(root, "crashes");
      const markerFile = path.join(root, "marker");
      const readyFile = path.join(root, "ready");

      const fakeScript = path.join(root, "fake-engine.sh");
      fs.writeFileSync(
        fakeScript,
        `#!/usr/bin/env bash
MARKER="${markerFile}"
READY="${readyFile}"
trap 'echo got-sigterm > "$MARKER"; exit 0' TERM
touch "$READY"
while true; do
  sleep 0.1
done
`,
        { mode: 0o755 },
      );

      const env = {
        ...process.env,
        MINIONS_LOG_DIR: logDir,
        MINIONS_CRASH_LOG_DIR: crashDir,
        MINIONS_ENGINE_CMD: `exec bash ${fakeScript}`,
        MINIONS_SUPERVISE_BACKOFF_MS_OVERRIDE: "100",
      };

      const child = spawn(TSX_BIN, [SUPERVISE_TS], { env, stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stderr?.on("data", (b: Buffer) => {
        stderr += b.toString("utf8");
      });

      const deadline = Date.now() + 5000;
      while (!fs.existsSync(readyFile)) {
        if (Date.now() > deadline) {
          child.kill("SIGKILL");
          throw new Error(`child never wrote ready marker. stderr:\n${stderr}`);
        }
        await new Promise((r) => setTimeout(r, 50));
      }

      child.kill("SIGTERM");

      const exitInfo = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          const t = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`supervisor did not exit within 5s. stderr:\n${stderr}`));
          }, 5000);
          child.once("exit", (code, signal) => {
            clearTimeout(t);
            resolve({ code, signal });
          });
        },
      );

      assert.equal(exitInfo.code, 0, `expected exit 0, got code=${exitInfo.code} signal=${exitInfo.signal}`);
      assert.equal(fs.existsSync(markerFile), true, "marker file written by child trap");
      assert.equal(fs.readFileSync(markerFile, "utf8").trim(), "got-sigterm");
    });
  });
});
