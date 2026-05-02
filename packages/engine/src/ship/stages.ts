import type { ShipStage } from "@minions/shared";

export const READ_ONLY_STAGES: ReadonlySet<ShipStage> = new Set<ShipStage>(["think", "plan"]);

export const THINK_DIRECTIVE = `You are entering the THINK stage. Your goal is to deeply understand the problem before proposing any solution. Review the provided context, codebase, and requirements. Identify ambiguities, risks, and constraints. Do not write code or make changes yet — only analyze and clarify. Do NOT write a plan file or any file to disk; do NOT wait for approval. When you have a thorough understanding, your FINAL action this turn must be a chat assistant message that summarizes your findings inline (problem framing, key constraints, risks, and the approach you intend to plan next). Output that summary directly in the chat — do not save it as a file, do not defer it, do not stop with only tool calls.`;

export const PLAN_DIRECTIVE = `You are entering the PLAN stage. Based on your analysis, produce a detailed implementation plan. Break the work into concrete, independently deliverable tasks. Each task should have a clear title, a specific prompt describing what to implement, and any dependencies on other tasks. Present the plan as a fenced \`\`\`dag block with JSON containing { title, goal, nodes: [{title, prompt, dependsOn?}] }.

Constraints the parser enforces:
- Every node needs a non-empty \`title\` and \`prompt\`. Titles must be unique within the DAG.
- \`dependsOn\` is an array of node titles. It may list multiple parents — the scheduler will spawn the child only after every listed parent reaches a successful terminal state. The child branch is based on \`dependsOn[0]\`, so list the predecessor whose code the child needs to extend FIRST; secondary deps come after.
- No cycles. No references to titles that aren't in the DAG.

Review the plan for completeness before signaling readiness.`;

export const DAG_DIRECTIVE = `You are entering the DAG stage. The plan has been parsed into a DAG of tasks. Sub-agents are now executing each node in dependency order. Your role is to monitor overall progress, answer any questions from sub-agents, and handle escalations. Do not implement tasks yourself — coordinate and provide guidance only. Once all nodes are completed and landed, signal that verification can begin.`;

export const VERIFY_DIRECTIVE = `You are entering the VERIFY stage. All planned tasks have been executed by sub-agents in their own worktrees, each landing a separate PR.

IMPORTANT: your own worktree is intentionally empty — \`git diff main...HEAD\` will show nothing. The work lives in the child PRs, not here. Per-child verifier sessions have already inspected each PR and queued any necessary fixes; this stage is a final cross-cutting check.

The most recent \`verify_summary\` status event in this transcript lists each child PR with its number and URL. Inspect them with:

  gh pr view <NUMBER>
  gh pr diff <NUMBER>
  gh pr checks <NUMBER>

Look for cross-cutting concerns the per-child verifiers can't see: integration gaps between PRs, missing pieces of the original requirements, regressions, drift from the plan. Do NOT re-verify each PR's individual acceptance criteria — the per-child verifiers already did that.

If the integrated outcome is sound, confirm completion and signal readiness for done. If you find cross-cutting gaps, report them clearly with specific PR numbers and follow-up actions.`;

export const DONE_DIRECTIVE = `You are entering the DONE stage. The work is complete and verified. Provide a concise summary of what was accomplished, any deviations from the original plan, and any follow-up recommendations. The session will be closed after this final summary.`;
