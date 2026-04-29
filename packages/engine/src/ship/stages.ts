import type { ShipStage } from "@minions/shared";

export const READ_ONLY_STAGES: ReadonlySet<ShipStage> = new Set<ShipStage>(["think", "plan"]);

export const THINK_DIRECTIVE = `You are entering the THINK stage. Your goal is to deeply understand the problem before proposing any solution. Review the provided context, codebase, and requirements. Identify ambiguities, risks, and constraints. Do not write code or make changes yet — only analyze and clarify. Do NOT write a plan file or any file to disk; do NOT wait for approval. When you have a thorough understanding, your FINAL action this turn must be a chat assistant message that summarizes your findings inline (problem framing, key constraints, risks, and the approach you intend to plan next). Output that summary directly in the chat — do not save it as a file, do not defer it, do not stop with only tool calls.`;

export const PLAN_DIRECTIVE = `You are entering the PLAN stage. Based on your analysis, produce a detailed implementation plan. Break the work into concrete, independently deliverable tasks. Each task should have a clear title, a specific prompt describing what to implement, and any dependencies on other tasks. Present the plan as a fenced \`\`\`dag block with JSON containing { title, goal, nodes: [{title, prompt, dependsOn?}] }. Review the plan for completeness before signaling readiness.`;

export const DAG_DIRECTIVE = `You are entering the DAG stage. The plan has been parsed into a DAG of tasks. Sub-agents are now executing each node in dependency order. Your role is to monitor overall progress, answer any questions from sub-agents, and handle escalations. Do not implement tasks yourself — coordinate and provide guidance only. Once all nodes are completed and landed, signal that verification can begin.`;

export const VERIFY_DIRECTIVE = `You are entering the VERIFY stage. All planned tasks have been executed. Your goal is to verify the overall outcome meets the original requirements. Run the full test suite, review the integrated diff, check that all acceptance criteria are satisfied, and look for regressions or gaps. Report any issues clearly. If everything is in order, confirm completion and signal readiness for done.`;

export const DONE_DIRECTIVE = `You are entering the DONE stage. The work is complete and verified. Provide a concise summary of what was accomplished, any deviations from the original plan, and any follow-up recommendations. The session will be closed after this final summary.`;
