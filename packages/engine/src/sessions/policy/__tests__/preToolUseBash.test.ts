import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(here, "../preToolUseBash.mjs");

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

async function run(
  payload: unknown,
  envOverrides: Record<string, string | undefined> = {},
): Promise<RunResult> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.MINIONS_SLUG;
  delete env.MINIONS_WORKTREE;
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) {
      delete env[k];
    } else {
      env[k] = v;
    }
  }

  const child = spawn(process.execPath, [scriptPath], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on("data", (c: Buffer) => stdoutChunks.push(c));
  child.stderr.on("data", (c: Buffer) => stderrChunks.push(c));

  child.stdin.write(JSON.stringify(payload));
  child.stdin.end();

  const exitCode = await new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
  });

  return {
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
    exitCode,
  };
}

function bashPayload(command: string) {
  return { tool_name: "Bash", tool_input: { command } };
}

interface BlockOutput {
  decision: string;
  reason: string;
}

describe("preToolUseBash policy hook", () => {
  test("blocks pnpm install with deps-cache reason", async () => {
    const result = await run(bashPayload("pnpm install"));
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout) as BlockOutput;
    assert.equal(parsed.decision, "block");
    assert.match(parsed.reason, /deps cache/);
  });

  test("allows ls -la with empty stdout", async () => {
    const result = await run(bashPayload("ls -la"));
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "");
  });

  test("allows force push to allowed minion branch", async () => {
    const result = await run(
      bashPayload("git push --force origin minions/test-slug"),
      { MINIONS_SLUG: "test-slug" },
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "");
  });

  test("blocks force push to main", async () => {
    const result = await run(bashPayload("git push --force origin main"), {
      MINIONS_SLUG: "test-slug",
    });
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout) as BlockOutput;
    assert.equal(parsed.decision, "block");
    assert.match(parsed.reason, /force push/);
  });

  test("blocks compound command containing pnpm install", async () => {
    const result = await run(bashPayload("mkdir x && pnpm install"));
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout) as BlockOutput;
    assert.equal(parsed.decision, "block");
  });

  test("allows non-force git push to main", async () => {
    const result = await run(bashPayload("git push origin main"), {
      MINIONS_SLUG: "test-slug",
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "");
  });

  test("blocks rm -rf outside worktree", async () => {
    const result = await run(bashPayload("rm -rf /tmp/foo"), {
      MINIONS_WORKTREE: "/work/wt",
    });
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout) as BlockOutput;
    assert.equal(parsed.decision, "block");
    assert.match(parsed.reason, /rm -rf/);
  });

  test("allows rm -rf inside worktree", async () => {
    const result = await run(bashPayload("rm -rf /work/wt/build"), {
      MINIONS_WORKTREE: "/work/wt",
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "");
  });

  test("blocks redirect write to .env", async () => {
    const result = await run(bashPayload("cat > .env"));
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout) as BlockOutput;
    assert.equal(parsed.decision, "block");
    assert.match(parsed.reason, /\.env|MINIONS_TOKEN|\.pem/);
  });

  test("allows reading .env with cat", async () => {
    const result = await run(bashPayload("cat .env"));
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "");
  });
});
