import type { DispatchCommandInput } from "../transport/rest.js";

export interface SlashArg {
  name: string;
  type: "string" | "enum" | "number";
  options?: string[];
  required?: boolean;
}

export interface SlashCommandResult {
  kind: "command";
  payload: DispatchCommandInput;
}

export interface SlashUiResult {
  kind: "ui";
  action: "help" | "cost";
}

export type SlashResult = SlashCommandResult | SlashUiResult;

export interface SlashContext {
  workflowId?: string;
  taskId?: string;
}

export interface SlashCommand {
  name: string;
  args: SlashArg[];
  hint: string;
  build(args: string[], ctx: SlashContext): SlashResult;
}

function requireWorkflowId(ctx: SlashContext, cmd: string): string {
  if (!ctx.workflowId) throw new Error(`/${cmd} requires an active workflow`);
  return ctx.workflowId;
}

function requireTaskId(ctx: SlashContext, cmd: string): string {
  if (!ctx.taskId) throw new Error(`/${cmd} requires an active task`);
  return ctx.taskId;
}

function requirePrompt(args: string[], cmd: string): string {
  const prompt = args.join(" ").trim();
  if (!prompt) throw new Error(`/${cmd} requires text`);
  return prompt;
}

export const slashCommands: SlashCommand[] = [
  {
    name: "help",
    args: [],
    hint: "Show all available commands",
    build: () => ({ kind: "ui", action: "help" }),
  },
  {
    name: "cost",
    args: [],
    hint: "Show task cost",
    build: () => ({ kind: "ui", action: "cost" }),
  },
  {
    name: "reply",
    args: [{ name: "text", type: "string", required: true }],
    hint: "Reply to the active task",
    build: (args, ctx) => ({
      kind: "command",
      payload: {
        kind: "continue-task",
        workflowId: requireWorkflowId(ctx, "reply"),
        taskId: requireTaskId(ctx, "reply"),
        prompt: requirePrompt(args, "reply"),
      },
    }),
  },
  {
    name: "retry",
    args: [{ name: "prompt", type: "string", required: true }],
    hint: "Retry the active task with a fresh prompt",
    build: (args, ctx) => ({
      kind: "command",
      payload: {
        kind: "retry-task",
        workflowId: requireWorkflowId(ctx, "retry"),
        taskId: requireTaskId(ctx, "retry"),
        prompt: requirePrompt(args, "retry"),
      },
    }),
  },
  {
    name: "clear",
    args: [],
    hint: "Clear conversation",
    build: (_args, ctx) => ({
      kind: "command",
      payload: {
        kind: "continue-task",
        workflowId: requireWorkflowId(ctx, "clear"),
        taskId: requireTaskId(ctx, "clear"),
        prompt: "/clear",
      },
    }),
  },
  {
    name: "compact",
    args: [],
    hint: "Compact conversation",
    build: (_args, ctx) => ({
      kind: "command",
      payload: {
        kind: "continue-task",
        workflowId: requireWorkflowId(ctx, "compact"),
        taskId: requireTaskId(ctx, "compact"),
        prompt: "/compact",
      },
    }),
  },
  {
    name: "cancel",
    args: [],
    hint: "Cancel the active task",
    build: (_args, ctx) => ({
      kind: "command",
      payload: {
        kind: "transition-task",
        workflowId: requireWorkflowId(ctx, "cancel"),
        transition: {
          kind: "cancel-task",
          taskId: requireTaskId(ctx, "cancel"),
          now: new Date().toISOString(),
        },
      },
    }),
  },
  {
    name: "land",
    args: [],
    hint: "Land the active workflow",
    build: (_args, ctx) => {
      return {
        kind: "command",
        payload: {
          kind: "land-workflow",
          workflowId: requireWorkflowId(ctx, "land"),
        },
      };
    },
  },
];
