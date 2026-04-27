import type { Command, SessionMode } from "@minions/shared";

export interface SlashArg {
  name: string;
  type: "string" | "enum" | "number";
  options?: string[];
  required?: boolean;
}

export interface SlashCommandResult {
  kind: "command";
  payload: Command;
}

export interface SlashMessageResult {
  kind: "message";
  payload: { prompt: string; mode?: SessionMode };
}

export interface SlashUiResult {
  kind: "ui";
  action: "help" | "stats" | "loops" | "config" | "doctor" | "status";
}

export type SlashResult = SlashCommandResult | SlashMessageResult | SlashUiResult;

export interface SlashContext {
  sessionSlug?: string;
  dagId?: string;
}

export interface SlashCommand {
  name: string;
  args: SlashArg[];
  hint: string;
  build(args: string[], ctx: SlashContext): SlashResult;
}

function requireSession(ctx: SlashContext, cmd: string): string {
  if (!ctx.sessionSlug) throw new Error(`/${cmd} requires an active session`);
  return ctx.sessionSlug;
}

function requireDag(ctx: SlashContext, cmd: string): string {
  if (!ctx.dagId) throw new Error(`/${cmd} requires an active DAG`);
  return ctx.dagId;
}

export const slashCommands: SlashCommand[] = [
  {
    name: "task",
    args: [{ name: "prompt", type: "string", required: true }],
    hint: "Start a task session",
    build: (args) => ({
      kind: "message",
      payload: { prompt: args.join(" "), mode: "task" },
    }),
  },
  {
    name: "plan",
    args: [{ name: "prompt", type: "string", required: true }],
    hint: "Start a plan session",
    build: (args) => ({
      kind: "message",
      payload: { prompt: args.join(" "), mode: "plan" },
    }),
  },
  {
    name: "think",
    args: [{ name: "prompt", type: "string", required: true }],
    hint: "Start a think session",
    build: (args) => ({
      kind: "message",
      payload: { prompt: args.join(" "), mode: "think" },
    }),
  },
  {
    name: "review",
    args: [{ name: "prompt", type: "string", required: true }],
    hint: "Start a review session",
    build: (args) => ({
      kind: "message",
      payload: { prompt: args.join(" "), mode: "review" },
    }),
  },
  {
    name: "ship",
    args: [{ name: "prompt", type: "string", required: true }],
    hint: "Start a ship session",
    build: (args) => ({
      kind: "message",
      payload: { prompt: args.join(" "), mode: "ship" },
    }),
  },
  {
    name: "retry",
    args: [],
    hint: "Retry the current session",
    build: (_args, ctx) => ({
      kind: "command",
      payload: { kind: "retry", sessionSlug: requireSession(ctx, "retry") },
    }),
  },
  {
    name: "done",
    args: [],
    hint: "Mark session as done",
    build: (_args, ctx) => ({
      kind: "command",
      payload: { kind: "done", sessionSlug: requireSession(ctx, "done") },
    }),
  },
  {
    name: "clean",
    args: [],
    hint: "Clean the session workspace",
    build: (_args, ctx) => ({
      kind: "command",
      payload: { kind: "clean", sessionSlug: requireSession(ctx, "clean") },
    }),
  },
  {
    name: "feedback",
    args: [
      { name: "rating", type: "enum", options: ["up", "down"], required: true },
      { name: "reason", type: "string", required: false },
    ],
    hint: "Submit feedback: up or down [reason]",
    build: (args, ctx) => {
      const rating = args[0] as "up" | "down";
      if (rating !== "up" && rating !== "down") {
        throw new Error("/feedback requires 'up' or 'down'");
      }
      const reason = args.slice(1).join(" ") || undefined;
      return {
        kind: "command",
        payload: {
          kind: "submit-feedback",
          sessionSlug: requireSession(ctx, "feedback"),
          rating,
          reason,
        },
      };
    },
  },
  {
    name: "force",
    args: [
      {
        name: "action",
        type: "enum",
        options: ["release-mutex", "skip-stage", "mark-ready"],
        required: true,
      },
    ],
    hint: "Force an action on the session",
    build: (args, ctx) => {
      const action = args[0] as "release-mutex" | "skip-stage" | "mark-ready";
      if (!["release-mutex", "skip-stage", "mark-ready"].includes(action)) {
        throw new Error("/force requires release-mutex | skip-stage | mark-ready");
      }
      return {
        kind: "command",
        payload: { kind: "force", sessionSlug: requireSession(ctx, "force"), action },
      };
    },
  },
  {
    name: "help",
    args: [],
    hint: "Show all available commands",
    build: () => ({ kind: "ui", action: "help" }),
  },
  {
    name: "judge",
    args: [{ name: "rubric", type: "string", required: false }],
    hint: "Run judge on variant sessions",
    build: (args, ctx) => ({
      kind: "command",
      payload: {
        kind: "judge",
        variantParentSlug: requireSession(ctx, "judge"),
        rubric: args.join(" ") || undefined,
      },
    }),
  },
  {
    name: "land",
    args: [
      {
        name: "strategy",
        type: "enum",
        options: ["merge", "squash", "rebase"],
        required: false,
      },
    ],
    hint: "Land the session PR",
    build: (args, ctx) => {
      const strategy = (args[0] as "merge" | "squash" | "rebase") || undefined;
      return {
        kind: "command",
        payload: {
          kind: "land",
          sessionSlug: requireSession(ctx, "land"),
          strategy,
        },
      };
    },
  },
  {
    name: "stats",
    args: [],
    hint: "Show usage stats",
    build: () => ({ kind: "ui", action: "stats" }),
  },
  {
    name: "usage",
    args: [],
    hint: "Alias for /stats",
    build: () => ({ kind: "ui", action: "stats" }),
  },
  {
    name: "loops",
    args: [],
    hint: "Open loops view",
    build: () => ({ kind: "ui", action: "loops" }),
  },
  {
    name: "config",
    args: [],
    hint: "Open runtime config drawer",
    build: () => ({ kind: "ui", action: "config" }),
  },
  {
    name: "doctor",
    args: [],
    hint: "Run diagnostics",
    build: () => ({ kind: "ui", action: "doctor" }),
  },
  {
    name: "split",
    args: [
      { name: "nodeId", type: "string", required: true },
      { name: "title", type: "string", required: true },
      { name: "prompt", type: "string", required: true },
    ],
    hint: 'Split a DAG node: <nodeId> "<title>" "<prompt>"',
    build: (args, ctx) => {
      const dagId = requireDag(ctx, "split");
      const nodeId = args[0];
      if (!nodeId) throw new Error("/split requires <nodeId>");
      const rest = args.slice(1).join(" ");
      const match = rest.match(/^"([^"]+)"\s+"([^"]+)"$/);
      if (!match) throw new Error('/split requires "<title>" "<prompt>"');
      const title = match[1];
      const prompt = match[2];
      if (!title || !prompt) throw new Error('/split requires "<title>" "<prompt>"');
      return {
        kind: "command",
        payload: {
          kind: "split",
          dagId,
          nodeId,
          newNodes: [{ title, prompt, dependsOn: [nodeId] }],
        },
      };
    },
  },
  {
    name: "stack",
    args: [
      {
        name: "action",
        type: "enum",
        options: ["show", "restack", "land-all"],
        required: true,
      },
    ],
    hint: "Stack operations: show | restack | land-all",
    build: (args, ctx) => {
      const action = args[0] as "show" | "restack" | "land-all";
      if (!["show", "restack", "land-all"].includes(action)) {
        throw new Error("/stack requires show | restack | land-all");
      }
      return {
        kind: "command",
        payload: {
          kind: "stack",
          sessionSlug: requireSession(ctx, "stack"),
          action,
        },
      };
    },
  },
  {
    name: "reply",
    args: [{ name: "text", type: "string", required: true }],
    hint: "Reply to the active session",
    build: (args, ctx) => ({
      kind: "command",
      payload: {
        kind: "reply",
        sessionSlug: requireSession(ctx, "reply"),
        text: args.join(" "),
      },
    }),
  },
  {
    name: "status",
    args: [],
    hint: "Show session status panel",
    build: () => ({ kind: "ui", action: "status" }),
  },
];
