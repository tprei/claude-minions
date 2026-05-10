import type { Artifact, Workflow } from "../domain/types.js";
import { createWorkflow } from "../domain/workflow.js";
import { transitionTask } from "../application/transitions.js";

export const fixedNow = "2026-05-04T11:19:00.000Z";

export function makeThreeNodeWorkflow(): Workflow {
  return createWorkflow(
    {
      id: "workflow-1",
      kind: "manual-dag",
      tasks: [
        {
          id: "backend",
          title: "Backend",
          prompt: "Build backend",
          claims: [{ scope: "src/backend/**", mode: "write" }],
        },
        {
          id: "frontend",
          title: "Frontend",
          prompt: "Build frontend",
          claims: [{ scope: "src/frontend/**", mode: "write" }],
        },
        {
          id: "tests",
          title: "Tests",
          prompt: "Test integration",
          dependsOn: ["backend", "frontend"],
          claims: [{ scope: "test/**", mode: "write" }],
        },
      ],
      policy: { maxConcurrent: 2 },
    },
    () => fixedNow,
  );
}

export function completeTask(workflow: Workflow, taskId: string, artifactRef: string): Workflow {
  const sessionId = `${taskId}-session`;
  const branch: Artifact = {
    kind: "branch",
    ref: artifactRef,
    producedBy: taskId,
    createdAt: fixedNow,
  };

  let next = transitionTask(workflow, { kind: "mark-ready", taskId, now: fixedNow });
  next = transitionTask(next, { kind: "mark-running", taskId, sessionId, now: fixedNow });
  next = transitionTask(next, {
    kind: "complete-runtime",
    taskId,
    expectedSessionId: sessionId,
    artifacts: [branch],
    now: fixedNow,
  });

  return next;
}
