import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(here, "../policy/preToolUseBash.mjs");

interface RunResult {
  stdout: string;
  exitCode: number | null;
}

function runHook(
  commandStr: string,
  env: Record<string, string> = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const baseEnv = { ...process.env };
    delete baseEnv["MINIONS_SLUG"];
    delete baseEnv["MINIONS_WORKTREE"];
    const child = spawn(process.execPath, [scriptPath], {
      env: { ...baseEnv, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ stdout, exitCode: code }));

    const payload = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: commandStr },
    });
    child.stdin.write(payload);
    child.stdin.end();
  });
}

describe("preToolUseBash policy hook", () => {
  test("blocks `pnpm install`", async () => {
    const r = await runHook("pnpm install");
    assert.equal(r.exitCode, 0);
    const parsed = JSON.parse(r.stdout) as { decision: string; reason: string };
    assert.equal(parsed.decision, "block");
    assert.match(parsed.reason, /deps cache/);
  });

  test("blocks `npm install lodash`", async () => {
    const r = await runHook("npm install lodash");
    assert.equal(r.exitCode, 0);
    const parsed = JSON.parse(r.stdout) as { decision: string };
    assert.equal(parsed.decision, "block");
  });

  test("blocks `npm i` short alias", async () => {
    const r = await runHook("npm i");
    assert.equal(r.exitCode, 0);
    const parsed = JSON.parse(r.stdout) as { decision: string };
    assert.equal(parsed.decision, "block");
  });

  test("allows `ls`", async () => {
    const r = await runHook("ls");
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, "");
  });

  test("allows force push to session branch", async () => {
    const slug = "abc123";
    const r = await runHook(`git push --force origin minions/${slug}`, {
      MINIONS_SLUG: slug,
    });
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, "");
  });

  test("blocks `git push --force origin main`", async () => {
    const r = await runHook("git push --force origin main", {
      MINIONS_SLUG: "abc123",
    });
    assert.equal(r.exitCode, 0);
    const parsed = JSON.parse(r.stdout) as { decision: string; reason: string };
    assert.equal(parsed.decision, "block");
    assert.match(parsed.reason, /main/);
  });

  test("blocks `rm -rf /tmp/foo` when worktree is /work/x", async () => {
    const r = await runHook("rm -rf /tmp/foo", {
      MINIONS_WORKTREE: "/work/x",
    });
    assert.equal(r.exitCode, 0);
    const parsed = JSON.parse(r.stdout) as { decision: string };
    assert.equal(parsed.decision, "block");
  });

  test("allows `rm -rf relative-dir` inside worktree", async () => {
    const r = await runHook("rm -rf relative-dir", {
      MINIONS_WORKTREE: "/work/x",
    });
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, "");
  });

  test("blocks `cat .env.production`", async () => {
    const r = await runHook("cat .env.production");
    assert.equal(r.exitCode, 0);
    const parsed = JSON.parse(r.stdout) as { decision: string; reason: string };
    assert.equal(parsed.decision, "block");
    assert.match(parsed.reason, /secret/);
  });
});
