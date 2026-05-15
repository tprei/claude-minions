import { spawn } from "node:child_process";
import { DomainError } from "../domain/errors.js";
import type { Logger } from "../observability/logger.js";
import type { WorkflowSpec, TaskSpec } from "../domain/types.js";

const VALID_KINDS = new Set(["single-task", "manual-dag"]);

interface RawTaskSpec {
  id: string;
  title: string;
  prompt: string;
  dependsOn?: string[];
}

interface RawPlan {
  kind: string;
  tasks: RawTaskSpec[];
}

const SYSTEM_PROMPT = `You are a task-graph planner. The user wants their work decomposed into a directed-acyclic task graph for agentic execution.

Rules:
- Return ONLY valid JSON. No markdown fences. No explanation text before or after the JSON.
- If a single agent run suffices, return kind "single-task" with exactly one task.
- If the work has clear sub-steps with ordering dependencies, return kind "manual-dag" with multiple tasks and explicit dependsOn relationships.
- Never return zero tasks.
- Task ids must be unique short strings (e.g. "t0", "t1", "t2").
- dependsOn must only reference ids of other tasks in the same response.
- Keep prompts concise but actionable.

Output schema (strict JSON, no extra fields at top level):
{
  "kind": "single-task" | "manual-dag",
  "tasks": [
    { "id": "t0", "title": "short title", "prompt": "detailed instructions", "dependsOn": [] },
    { "id": "t1", "title": "short title", "prompt": "detailed instructions", "dependsOn": ["t0"] }
  ]
}`;

export type RunClaudeFn = (prompt: string, signal?: AbortSignal) => Promise<string>;

export interface WorkflowPlannerServiceDeps {
  runClaude?: RunClaudeFn;
  claudeCommand?: string[];
  log: Logger;
  now: () => string;
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function detectCycle(tasks: RawTaskSpec[]): boolean {
  const indices = new Map<string, number>();
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    if (task) indices.set(task.id, i);
  }

  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(id: string): boolean {
    if (inStack.has(id)) return true;
    if (visited.has(id)) return false;
    visited.add(id);
    inStack.add(id);
    const idx = indices.get(id);
    if (idx !== undefined) {
      const task = tasks[idx];
      for (const dep of task?.dependsOn ?? []) {
        if (dfs(dep)) return true;
      }
    }
    inStack.delete(id);
    return false;
  }

  for (const task of tasks) {
    if (dfs(task.id)) return true;
  }
  return false;
}

function spawnClaude(claudeCommand: string[], prompt: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const [cmd, ...baseArgs] = claudeCommand;
    if (!cmd) {
      reject(new Error("claudeCommand must be non-empty"));
      return;
    }
    const args = [
      ...baseArgs,
      "--system-prompt", SYSTEM_PROMPT,
      "--output-format", "json",
      "--no-session-persistence",
      prompt,
    ];

    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });

    if (signal) {
      const onAbort = () => { child.kill("SIGTERM"); };
      signal.addEventListener("abort", onAbort, { once: true });
      child.once("exit", () => signal.removeEventListener("abort", onAbort));
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.on("error", (err) => reject(err));

    child.on("close", (code) => {
      if (signal?.aborted) {
        reject(new DomainError("invalid_plan", "planner: request aborted", {}));
        return;
      }
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8").slice(0, 400);
        reject(new Error(`claude exited with code ${String(code)}: ${stderr}`));
        return;
      }
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      let resultText: string;
      try {
        const envelope = JSON.parse(stdout) as { result?: string };
        resultText = envelope.result ?? stdout;
      } catch {
        resultText = stdout;
      }
      resolve(resultText);
    });
  });
}

function extractJson(text: string): RawPlan {
  const trimmed = text.trim();

  // Try direct parse first
  try {
    return JSON.parse(trimmed) as RawPlan;
  } catch {
    // fall through
  }

  // Strip markdown fences: ```json ... ``` or ``` ... ```
  const fenceMatch = /^```(?:json)?\s*([\s\S]*?)```\s*$/m.exec(trimmed);
  if (fenceMatch?.[1]) {
    try {
      return JSON.parse(fenceMatch[1].trim()) as RawPlan;
    } catch {
      // fall through
    }
  }

  // Extract largest balanced {...} block
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] !== "{") continue;
    let depth = 0;
    let j = i;
    for (; j < trimmed.length; j++) {
      if (trimmed[j] === "{") depth++;
      else if (trimmed[j] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth === 0 && j - i + 1 > bestLen) {
      bestStart = i;
      bestLen = j - i + 1;
    }
  }
  if (bestStart >= 0) {
    try {
      return JSON.parse(trimmed.slice(bestStart, bestStart + bestLen)) as RawPlan;
    } catch {
      // fall through
    }
  }

  throw new Error("no parseable JSON found");
}

export class WorkflowPlannerService {
  private readonly deps: WorkflowPlannerServiceDeps;
  private readonly claudeCommand: string[];

  constructor(deps: WorkflowPlannerServiceDeps) {
    this.deps = deps;
    this.claudeCommand = deps.claudeCommand ?? ["claude", "-p"];
  }

  async plan({ prompt, repoId, signal }: { prompt: string; repoId: string; signal?: AbortSignal }): Promise<WorkflowSpec> {
    const { log } = this.deps;

    log.info("planner: requesting plan", { prompt: prompt.slice(0, 80) });

    const runClaude = this.deps.runClaude ?? ((p: string, sig?: AbortSignal) => spawnClaude(this.claudeCommand, p, sig));
    const responseText = await runClaude(prompt, signal);

    let raw: RawPlan;
    try {
      raw = extractJson(responseText);
    } catch {
      log.error("planner: failed to parse JSON", { text: responseText.slice(0, 200) });
      throw new DomainError("invalid_plan", "planner: LLM returned invalid JSON", { text: responseText.slice(0, 200) });
    }

    if (!VALID_KINDS.has(raw.kind)) {
      throw new DomainError("invalid_plan", `planner: invalid kind "${raw.kind}"`, { kind: raw.kind });
    }

    if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) {
      throw new DomainError("invalid_plan", "planner: plan must contain at least one task", {});
    }

    const taskIds = new Set<string>();
    for (const task of raw.tasks) {
      if (typeof task.id !== "string" || typeof task.title !== "string" || typeof task.prompt !== "string") {
        throw new DomainError("invalid_plan", "planner: task missing required fields (id, title, prompt)", {});
      }
      if (taskIds.has(task.id)) {
        throw new DomainError("invalid_plan", `planner: duplicate task id "${task.id}"`, { taskId: task.id });
      }
      taskIds.add(task.id);
    }

    for (const task of raw.tasks) {
      for (const dep of task.dependsOn ?? []) {
        if (!taskIds.has(dep)) {
          throw new DomainError("invalid_plan", `planner: task "${task.id}" depends on unknown task "${dep}"`, { taskId: task.id, dep });
        }
      }
    }

    if (detectCycle(raw.tasks)) {
      throw new DomainError("invalid_plan", "planner: task graph contains a cycle", {});
    }

    const workflowId = generateId("wf");
    const idMap = new Map<string, string>();
    for (const task of raw.tasks) {
      idMap.set(task.id, generateId("t"));
    }

    const taskSpecs: TaskSpec[] = raw.tasks.map((task) => ({
      id: idMap.get(task.id)!,
      title: task.title,
      prompt: task.prompt,
      dependsOn: (task.dependsOn ?? []).map((dep) => idMap.get(dep)!),
    }));

    const spec: WorkflowSpec = {
      id: workflowId,
      kind: raw.kind as WorkflowSpec["kind"],
      repoId,
      tasks: taskSpecs,
    };

    log.info("planner: plan complete", { workflowId, taskCount: taskSpecs.length, kind: spec.kind, repoId });
    return spec;
  }
}
