import Anthropic from "@anthropic-ai/sdk";
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

type MessagesCreateCallable = (
  params: Anthropic.MessageCreateParamsNonStreaming,
) => Promise<Anthropic.Message>;

export interface WorkflowPlannerServiceDeps {
  apiKey: string;
  model: string;
  log: Logger;
  now: () => string;
  /** Seam for testing — overrides the real Anthropic client call. */
  messagesCreate?: MessagesCreateCallable;
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

export class WorkflowPlannerService {
  private readonly deps: WorkflowPlannerServiceDeps;
  private readonly messagesCreate: MessagesCreateCallable;

  constructor(deps: WorkflowPlannerServiceDeps) {
    this.deps = deps;
    if (deps.messagesCreate) {
      this.messagesCreate = deps.messagesCreate;
    } else {
      const client = new Anthropic({ apiKey: deps.apiKey });
      this.messagesCreate = (params) => client.messages.create(params);
    }
  }

  async plan({ prompt }: { prompt: string }): Promise<WorkflowSpec> {
    const { model, log } = this.deps;

    log.info("planner: requesting plan", { prompt: prompt.slice(0, 80) });

    const response = await this.messagesCreate({
      model,
      max_tokens: 2048,
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        { role: "user", content: prompt },
      ],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new DomainError("invalid_plan", "planner: no text block in response", {});
    }

    let raw: RawPlan;
    try {
      raw = JSON.parse(textBlock.text) as RawPlan;
    } catch {
      log.error("planner: failed to parse JSON", { text: textBlock.text.slice(0, 200) });
      throw new DomainError("invalid_plan", "planner: LLM returned invalid JSON", { text: textBlock.text.slice(0, 200) });
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
      tasks: taskSpecs,
    };

    log.info("planner: plan complete", { workflowId, taskCount: taskSpecs.length, kind: spec.kind });
    return spec;
  }
}
