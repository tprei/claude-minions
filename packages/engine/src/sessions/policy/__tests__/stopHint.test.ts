import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(here, "../stopHint.mjs");

describe("stopHint policy hook", () => {
  test("emits a commit reminder on stdout and exits 0", async () => {
    const child = spawn(process.execPath, [scriptPath], {
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => stdoutChunks.push(c));

    child.stdin.write(JSON.stringify({}));
    child.stdin.end();

    const exitCode = await new Promise<number | null>((resolve) => {
      child.once("exit", (code) => resolve(code));
    });

    assert.equal(exitCode, 0);
    const stdout = Buffer.concat(stdoutChunks).toString("utf8");
    assert.match(stdout, /commit/);
  });
});
