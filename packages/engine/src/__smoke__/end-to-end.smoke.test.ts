import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { simpleGit } from "simple-git";
import { createEngine } from "../index.js";
import { createLogger } from "../logger.js";
import { loadEnv } from "../env.js";
import { registerProvider } from "../providers/registry.js";
import type {
  AgentProvider,
  ParseStreamState,
  ProviderEvent,
  ProviderHandle,
  ProviderResumeOpts,
  ProviderSpawnOpts,
} from "../providers/provider.js";
import type { EngineEnv } from "../env.js";

const SMOKE_PROVIDER_NAME = "smoke-self-provider";
const REPO_ID = "smoke-self";

function buildSmokeHandle(opts: ProviderSpawnOpts): ProviderHandle {
  const fileWritten = (async () => {
    await fs.promises.writeFile(
      path.join(opts.worktree, "smoke.txt"),
      `smoke session ${opts.sessionSlug}\n`,
      "utf8",
    );
  })();

  let exited = false;
  let exitResolve: (v: { code: number | null; signal: NodeJS.Signals | null }) => void = () => {};
  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => {
    exitResolve = r;
  });

  const events: ProviderEvent[] = [
    { kind: "turn_started" },
    { kind: "assistant_text", text: `smoke: working on ${opts.sessionSlug}` },
    { kind: "assistant_text", text: "smoke: done" },
    { kind: "turn_completed", outcome: "success" },
  ];

  return {
    pid: undefined,
    externalId: `smoke-${opts.sessionSlug}`,
    kill(signal) {
      if (exited) return;
      exited = true;
      exitResolve({ code: null, signal });
    },
    write() {},
    async *[Symbol.asyncIterator]() {
      await fileWritten;
      for (const ev of events) {
        if (exited) return;
        yield ev;
      }
      if (!exited) {
        exited = true;
        exitResolve({ code: 0, signal: null });
      }
    },
    waitForExit() {
      return exitPromise;
    },
  };
}

const smokeProvider: AgentProvider = {
  name: SMOKE_PROVIDER_NAME,
  async spawn(opts: ProviderSpawnOpts): Promise<ProviderHandle> {
    return buildSmokeHandle(opts);
  },
  async resume(opts: ProviderResumeOpts): Promise<ProviderHandle> {
    return buildSmokeHandle({
      sessionSlug: opts.sessionSlug,
      worktree: opts.worktree,
      prompt: "(resumed)",
      env: opts.env,
    });
  },
  parseStreamChunk(_buf: string, state: ParseStreamState) {
    return { events: [], state };
  },
  detectQuotaError() {
    return false;
  },
};

registerProvider(smokeProvider);

function gitInit(dir: string, args: string[] = []): void {
  execFileSync("git", ["init", ...args, dir], { stdio: "ignore" });
}

function gitRun(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8").trim();
}

function setupFakeRemote(): { remote: string; cleanup: () => void } {
  const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-bare-"));
  const seedDir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-seed-"));

  gitInit(bareDir, ["--bare", "--initial-branch=main"]);
  gitInit(seedDir, ["--initial-branch=main"]);

  gitRun(seedDir, ["config", "user.email", "smoke@minions.local"]);
  gitRun(seedDir, ["config", "user.name", "smoke"]);
  fs.writeFileSync(path.join(seedDir, "README.md"), "# smoke-self\n", "utf8");
  gitRun(seedDir, ["add", "README.md"]);
  gitRun(seedDir, ["commit", "-m", "init"]);
  gitRun(seedDir, ["branch", "-M", "main"]);
  gitRun(seedDir, ["remote", "add", "origin", bareDir]);
  gitRun(seedDir, ["push", "-u", "origin", "main"]);

  return {
    remote: bareDir,
    cleanup: () => {
      fs.rmSync(bareDir, { recursive: true, force: true });
      fs.rmSync(seedDir, { recursive: true, force: true });
    },
  };
}

function buildSmokeEnv(workspace: string): EngineEnv {
  const base = loadEnv({ MINIONS_TOKEN: "smoke-token" });
  return {
    ...base,
    port: 0,
    host: "127.0.0.1",
    token: "smoke-token",
    corsOrigins: [],
    workspace,
    provider: SMOKE_PROVIDER_NAME,
    logLevel: "error",
    vapid: null,
    githubApp: null,
    resourceSampleSec: 99999,
    loopTickSec: 99999,
    loopReservedInteractive: 4,
    ssePingSec: 99999,
  };
}

after(() => {
  // Engine subsystems schedule heartbeats and pollers; even with shutdown
  // hooks unwound, some Node internals (e.g., simple-git child reaping) can
  // hold the loop briefly. Force-exit so the smoke test never hangs CI.
  setImmediate(() => process.exit(0));
});

test("end-to-end smoke: boot → task → commit → push → shutdown", { timeout: 60_000 }, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-ws-"));
  const fakeRemote = setupFakeRemote();

  const reposJson = [
    {
      id: REPO_ID,
      label: "Smoke Self",
      remote: fakeRemote.remote,
      defaultBranch: "main",
    },
  ];
  fs.writeFileSync(
    path.join(workspace, "repos.json"),
    JSON.stringify(reposJson, null, 2),
    "utf8",
  );

  const env = buildSmokeEnv(workspace);
  const log = createLogger("error", { service: "smoke" });
  const ctx = await createEngine(env, log);

  try {
    // Disable CI self-heal parking so the session terminates at "completed"
    // instead of being moved to "waiting_input" by the auto-land handler.
    await ctx.runtime.update({ ciSelfHealMaxAttempts: 0 });

    const session = await ctx.sessions.create({
      prompt: "smoke test",
      mode: "task",
      repoId: REPO_ID,
    });

    const deadline = Date.now() + 30_000;
    let final = ctx.sessions.get(session.slug);
    while (Date.now() < deadline) {
      final = ctx.sessions.get(session.slug);
      if (final?.status === "completed" || final?.status === "failed") break;
      await new Promise((r) => setTimeout(r, 100));
    }

    assert.equal(final?.status, "completed", `session did not complete in 30s; status=${final?.status}`);
    assert.ok(final?.worktreePath, "completed session should have a worktree path");
    assert.ok(final?.branch, "completed session should have a branch");

    const transcript = ctx.sessions.transcript(session.slug);
    const assistantText = transcript.find((e) => e.kind === "assistant_text");
    assert.ok(
      assistantText,
      "transcript must include at least one assistant_text event from the provider",
    );

    // Auto-commit handler runs after completion; allow a short window for
    // it to land the worktree write into a real commit.
    const commitDeadline = Date.now() + 10_000;
    let headSha = "";
    while (Date.now() < commitDeadline) {
      try {
        headSha = gitRun(final!.worktreePath!, ["rev-parse", "HEAD"]);
        const subject = gitRun(final!.worktreePath!, ["log", "-1", "--pretty=%s"]);
        if (subject.includes(session.slug)) break;
      } catch {
        /* worktree may briefly be busy during auto-commit */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(headSha, "expected a commit on the session worktree branch after completion");
    const subject = gitRun(final!.worktreePath!, ["log", "-1", "--pretty=%s"]);
    assert.match(
      subject,
      new RegExp(`session:${session.slug}`),
      `auto-commit subject should reference the session slug, got: ${subject}`,
    );

    // The auto-land handler always runs for completed task sessions with a
    // repoId; it calls landing.openForReview, which in turn invokes
    // ensurePushedAndPRed. With a local file remote, landing skips the push
    // and records landing.push_and_pr.skipped instead of issuing
    // landing.pr.ensure.start — that is the offline equivalent. Either
    // marker proves the auto-open-review path was reached.
    const auditDeadline = Date.now() + 10_000;
    let audit = ctx.audit.list(500);
    let auditActions = audit.map((e) => e.action);
    while (Date.now() < auditDeadline) {
      audit = ctx.audit.list(500);
      auditActions = audit.map((e) => e.action);
      if (audit.some((e) => e.action === "session.auto-land" && e.target?.id === session.slug)) {
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    const autoLand = audit.find(
      (e) => e.action === "session.auto-land" && e.target?.id === session.slug,
    );
    assert.ok(autoLand, "session.auto-land audit event must be recorded for the session");
    const ensureStartOrSkipped = auditActions.some(
      (a) => a === "landing.pr.ensure.start" || a === "landing.push_and_pr.skipped",
    );
    assert.ok(
      ensureStartOrSkipped,
      `auto-open-review path must reach landing; saw actions: ${auditActions.join(",")}`,
    );

    // Push manually to the fake remote so we can verify the worktree's
    // commit propagates round-trip — the engine itself short-circuits the
    // push for offline file remotes, so we drive the push from the test.
    const wtGit = simpleGit(final!.worktreePath!);
    await wtGit.push(["origin", final!.branch!]);

    const remoteSha = gitRun(fakeRemote.remote, ["rev-parse", `refs/heads/${final!.branch!}`]);
    assert.equal(
      remoteSha,
      headSha,
      "fake remote should advertise the same SHA after manual push",
    );
  } finally {
    await ctx.shutdown();
    fs.rmSync(workspace, { recursive: true, force: true });
    fakeRemote.cleanup();
  }
});
