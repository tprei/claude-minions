import { DomainError } from "../domain/errors.js";
import type { Workflow } from "../domain/types.js";
import { slugify } from "../plugins/workspace-backend.js";

export function deriveBranch(workflowId: string, taskId: string): string {
  return `minions/${slugify(workflowId)}_${slugify(taskId)}`;
}

// All transitive `dependsOn` ancestors of a task (excluding the task itself),
// restricted to tasks present in the graph.
export function transitiveDependencies(workflow: Workflow, taskId: string): Set<string> {
  const ancestors = new Set<string>();
  const stack = [...(workflow.graph[taskId]?.dependsOn ?? [])];
  while (stack.length > 0) {
    const next = stack.pop()!;
    if (ancestors.has(next)) continue;
    if (workflow.graph[next] === undefined) continue;
    ancestors.add(next);
    stack.push(...workflow.graph[next]!.dependsOn);
  }
  return ancestors;
}

// The git ref a task's worktree should be branched from so the agent builds on
// top of its dependencies, or undefined to branch from the repo's default branch.
//
// - 0 deps: undefined (default branch).
// - 1 dep: that dependency's branch.
// - N deps: the dominating dependency — the one whose transitive dependency
//   closure contains every other dependency (a linearizable join). Independent
//   parents have no dominating dependency and require an octopus-merge base,
//   which is not yet supported.
export function stackBaseRef(workflow: Workflow, taskId: string): string | undefined {
  const task = workflow.graph[taskId];
  if (!task) return undefined;

  const deps = task.dependsOn.filter((depId) => workflow.graph[depId] !== undefined);
  if (deps.length === 0) return undefined;
  if (deps.length === 1) return deriveBranch(workflow.id, deps[0]!);

  const dominating = deps.find((candidate) => {
    const closure = transitiveDependencies(workflow, candidate);
    return deps.every((other) => other === candidate || closure.has(other));
  });

  if (dominating === undefined) {
    throw new DomainError(
      "unstackable_dependencies",
      "task has independent parents that require an octopus-merge base, which is not yet supported",
      { taskId, dependsOn: deps },
    );
  }

  return deriveBranch(workflow.id, dominating);
}
