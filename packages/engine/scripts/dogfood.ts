import { createAdaptorServer } from "@hono/node-server";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createEngine, type Engine } from "../src/engine.js";
import { ClaudeCodeProvider } from "../src/plugins/providers/claude-code.js";
import { TmuxRuntimeBackend } from "../src/plugins/tmux/tmux-runtime.js";
import { StubQualityPlugin } from "../src/plugins/quality/stub-quality-plugin.js";
import type { Workflow, WorkflowSpec } from "../src/domain/types.js";
import type { WorkflowEvent } from "../src/domain/events.js";

const execFile = promisify(execFileCallback);

const DEFAULT_TIMEOUT_MS = 20 * 60_000;
const DOGFOOD_LINE = "dogfood verified";

interface HttpClient {
  get(path: string): Promise<{ status: number; data: unknown; text: string }>;
  post(path: string, body: unknown): Promise<{ status: number; data: unknown; text: string }>;
}

interface DogfoodReport {
  startedAt: string;
  completedAt?: string;
  fixtureRepo: string;
  workflowId?: string;
  taskIds?: string[];
  terminalStatus?: string;
  transitions: Array<{
    taskId: string;
    fromExecutionStatus: string;
    toExecutionStatus: string;
    transitionKind: string;
    cursor: number;
  }>;
  alertCounts: Record<string, number>;
  doctorStatus?: string;
  metricsObserved: string[];
  gitLog?: string;
  dogfoodFile?: string;
  error?: string;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number`);
  return parsed;
}

async function run(command: string, args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFile(command, args, cwd ? { cwd } : undefined);
  return stdout.trim();
}

async function preflight(): Promise<void> {
  await run("git", ["--version"]);
  await run("tmux", ["-V"]);
  await run("claude", ["--version"]);
  if (
    process.env["GITHUB_ACTIONS"] === "true" &&
    !process.env["ANTHROPIC_API_KEY"] &&
    !process.env["CLAUDE_CODE_OAUTH_TOKEN"]
  ) {
    throw new Error("dogfood requires ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN in GitHub Actions");
  }
}

async function createFixtureRepo(root: string): Promise<string> {
  const repoPath = join(root, "fixture-repo");
  await mkdir(repoPath, { recursive: true });
  await run("git", ["init", "-b", "main"], repoPath);
  await run("git", ["config", "user.email", "minions@local"], repoPath);
  await run("git", ["config", "user.name", "minions"], repoPath);
  await writeFile(join(repoPath, "README.md"), "# Dogfood fixture\n", "utf8");
  await writeFile(join(repoPath, "DOGFOOD.md"), "dogfood start\n", "utf8");
  await run("git", ["add", "README.md", "DOGFOOD.md"], repoPath);
  await run("git", ["commit", "-m", "seed dogfood fixture"], repoPath);
  return repoPath;
}

async function bindEngine(engine: Engine): Promise<{ baseUrl: string; client: HttpClient; close: () => Promise<void> }> {
  const httpServer = createAdaptorServer({ fetch: engine.server.fetch });
  const port = await new Promise<number>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => {
      const addr = httpServer.address();
      if (!addr || typeof addr !== "object") {
        reject(new Error("could not determine bound port"));
        return;
      }
      resolve(addr.port);
    });
  });
  const baseUrl = `http://127.0.0.1:${port}`;

  async function parse(res: Response): Promise<{ status: number; data: unknown; text: string }> {
    const text = await res.text();
    const contentType = res.headers.get("content-type") ?? "";
    const data = contentType.includes("application/json") && text ? JSON.parse(text) as unknown : text;
    return { status: res.status, data, text };
  }

  return {
    baseUrl,
    client: {
      get: (path) => fetch(`${baseUrl}${path}`).then(parse),
      post: (path, body) => fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }).then(parse),
    },
    close: () => new Promise((resolve, reject) => {
      httpServer.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    }),
  };
}

function assertStatus(label: string, actual: number, expected: number, body: unknown): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected HTTP ${expected}, got ${actual}: ${JSON.stringify(body)}`);
  }
}

function parseSseBlock(block: string): { event: string; data: string } | null {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) data.push(line.slice("data:".length).trimStart());
  }
  if (data.length === 0) return null;
  return { event, data: data.join("\n") };
}

async function watchTaskTransitions(
  url: string,
  timeoutMs: number,
  report: DogfoodReport,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok || !res.body) throw new Error(`SSE connect failed: HTTP ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const match = /\r?\n\r?\n/.exec(buffer);
        if (!match) break;
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const parsed = parseSseBlock(block);
        if (!parsed || parsed.event !== "task-transitioned") continue;
        const event = JSON.parse(parsed.data) as Extract<WorkflowEvent, { kind: "task-transitioned" }>;
        report.transitions.push({
          taskId: event.payload.taskId,
          fromExecutionStatus: event.payload.fromExecutionStatus,
          toExecutionStatus: event.payload.toExecutionStatus,
          transitionKind: event.payload.transitionKind,
          cursor: event.cursor,
        });
        if (event.payload.toExecutionStatus === "merged") return "merged";
        if (
          event.payload.toExecutionStatus === "failed" ||
          event.payload.toExecutionStatus === "cancelled" ||
          event.payload.toExecutionStatus === "needs-review"
        ) {
          throw new Error(`dogfood task ended ${event.payload.toExecutionStatus}`);
        }
      }
    }
    throw new Error("SSE ended before terminal transition");
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function getSpec(data: unknown): WorkflowSpec {
  const spec = (data as { spec?: unknown }).spec as WorkflowSpec | undefined;
  if (!spec) throw new Error("planner response missing spec");
  if (spec.kind !== "single-task" || spec.tasks.length !== 1) {
    throw new Error(`dogfood planner must return one single-task task, got ${spec.kind} with ${spec.tasks.length} tasks`);
  }
  return {
    ...spec,
    policy: { maxConcurrent: 1, autoLand: true, autoMergeOnGreen: false },
  };
}

function summarizeAlerts(alerts: unknown): Record<string, number> {
  const rows = ((alerts as { alerts?: unknown[] }).alerts ?? []) as Array<{ kind?: string }>;
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const kind = row.kind ?? "unknown";
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return counts;
}

function assertAlertEnvelope(actual: Record<string, number>): void {
  const expected = JSON.parse(process.env["MWF_DOGFOOD_EXPECT_ALERTS"] ?? "{}") as Record<string, number>;
  const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
  for (const key of keys) {
    if ((actual[key] ?? 0) !== (expected[key] ?? 0)) {
      throw new Error(`unexpected alert count for ${key}: expected ${expected[key] ?? 0}, got ${actual[key] ?? 0}`);
    }
  }
  if ((actual["merge-inconsistent"] ?? 0) > 0) throw new Error("dogfood produced merge-inconsistent alert");
  if ((actual["boot-recovery-failed"] ?? 0) > 0) throw new Error("dogfood produced boot-recovery-failed alert");
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  await preflight();

  const keep = process.env["MWF_DOGFOOD_KEEP_TMP"] === "1";
  const timeoutMs = envInt("MWF_DOGFOOD_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
  const root = process.env["MWF_DOGFOOD_ROOT"] ?? await mkdtemp(join(tmpdir(), "mwf-dogfood-"));
  const reportPath = process.env["MWF_DOGFOOD_REPORT"] ?? join(process.cwd(), "dogfood-report.json");
  const repoPath = await createFixtureRepo(root);
  const report: DogfoodReport = {
    startedAt,
    fixtureRepo: repoPath,
    transitions: [],
    alertCounts: {},
    metricsObserved: [],
  };

  let engine: Engine | undefined;
  let bound: Awaited<ReturnType<typeof bindEngine>> | undefined;
  try {
    engine = await createEngine({
      dbPath: join(root, "engine.db"),
      dataDir: join(root, "sessions"),
      repoPath,
      workspaceRoot: join(root, "worktrees"),
      runtime: new TmuxRuntimeBackend({ dataDir: join(root, "sessions") }),
      providerFactory: () => new ClaudeCodeProvider(),
      providerName: "claude-code",
      qualityPlugin: new StubQualityPlugin(),
      recoveryScanIntervalMs: 30_000,
      buildSha: process.env["GITHUB_SHA"] ?? "dogfood-local",
    });
    bound = await bindEngine(engine);

    const planPrompt = process.env["MWF_DOGFOOD_PROMPT"] ??
      `Create exactly one single-task workflow. The task must append one line containing "${DOGFOOD_LINE}" to DOGFOOD.md in the repository, make no other file changes, and commit the change.`;
    const plan = await bound.client.post("/workflows/plan", { prompt: planPrompt, repoId: "fixture-repo" });
    assertStatus("POST /workflows/plan", plan.status, 200, plan.data);
    const spec = getSpec(plan.data);
    report.workflowId = spec.id;
    report.taskIds = spec.tasks.map((task) => task.id);

    const create = await bound.client.post("/workflows", spec);
    assertStatus("POST /workflows", create.status, 201, create.data);
    const terminal = await watchTaskTransitions(
      `${bound.baseUrl}/workflows/${spec.id}/events`,
      timeoutMs,
      report,
    );
    report.terminalStatus = terminal;

    const workflowRes = await bound.client.get(`/workflows/${spec.id}`);
    assertStatus("GET /workflows/:id", workflowRes.status, 200, workflowRes.data);
    const workflow = workflowRes.data as Workflow;
    if (workflow.status !== "completed") {
      throw new Error(`expected completed workflow, got ${workflow.status}`);
    }

    const alertsRes = await bound.client.get("/alerts");
    assertStatus("GET /alerts", alertsRes.status, 200, alertsRes.data);
    report.alertCounts = summarizeAlerts(alertsRes.data);
    assertAlertEnvelope(report.alertCounts);

    const doctorRes = await bound.client.get("/doctor");
    if (doctorRes.status !== 200 && doctorRes.status !== 503) {
      throw new Error(`GET /doctor: unexpected HTTP ${doctorRes.status}`);
    }
    report.doctorStatus = (doctorRes.data as { status?: string }).status;
    if (report.doctorStatus === "error") throw new Error("doctor reported error status");

    const metricsRes = await bound.client.get("/metrics");
    assertStatus("GET /metrics", metricsRes.status, 200, metricsRes.text);
    report.metricsObserved = metricsRes.text
      .split("\n")
      .filter((line) => line.startsWith("minions_"))
      .slice(0, 25);

    report.gitLog = await run("git", ["log", "--oneline", "-3"], repoPath);
    report.dogfoodFile = await readFile(join(repoPath, "DOGFOOD.md"), "utf8");
    if (!report.dogfoodFile.includes(DOGFOOD_LINE)) {
      throw new Error(`DOGFOOD.md does not contain "${DOGFOOD_LINE}"`);
    }
    report.completedAt = new Date().toISOString();
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  } catch (err) {
    report.error = err instanceof Error ? err.message : String(err);
    report.completedAt = new Date().toISOString();
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8").catch(() => {});
    throw err;
  } finally {
    await bound?.close().catch(() => {});
    await engine?.close().catch(() => {});
    if (!keep && process.env["MWF_DOGFOOD_ROOT"] === undefined) {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  }
}

main().catch((err: unknown) => {
  console.error("DOGFOOD VERIFY FAIL:", err instanceof Error ? err.message : err);
  process.exit(1);
});
