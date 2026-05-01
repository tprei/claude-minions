import type { AttachmentInput } from "./session.js";

export interface ReplyCommand {
  kind: "reply";
  sessionSlug: string;
  text: string;
  attachments?: AttachmentInput[];
}

export interface StopCommand {
  kind: "stop";
  sessionSlug: string;
  reason?: string;
}

export interface CloseCommand {
  kind: "close";
  sessionSlug: string;
  removeWorktree?: boolean;
}

export interface PlanActionCommand {
  kind: "plan-action";
  sessionSlug: string;
  action: "approve" | "revise" | "discard" | "execute";
  note?: string;
}

export interface ShipAdvanceCommand {
  kind: "ship-advance";
  sessionSlug: string;
  toStage?: "think" | "plan" | "dag" | "verify" | "done";
  note?: string;
}

export interface LandCommand {
  kind: "land";
  sessionSlug: string;
  strategy?: "merge" | "squash" | "rebase";
  force?: boolean;
}

export interface OpenForReviewCommand {
  kind: "open-for-review";
  sessionSlug: string;
}

export interface RetryRebaseCommand {
  kind: "retry-rebase";
  sessionSlug: string;
}

export interface SubmitFeedbackCommand {
  kind: "submit-feedback";
  sessionSlug: string;
  eventId?: string;
  rating: "up" | "down";
  reason?: string;
}

export interface ForceCommand {
  kind: "force";
  sessionSlug: string;
  action: "release-mutex" | "skip-stage" | "mark-ready";
}

export interface RetryCommand {
  kind: "retry";
  sessionSlug: string;
  fromTurn?: number;
}

export interface JudgeCommand {
  kind: "judge";
  variantParentSlug: string;
  rubric?: string;
}

export interface SplitCommand {
  kind: "split";
  dagId: string;
  nodeId: string;
  newNodes: { title: string; prompt: string; dependsOn: string[] }[];
}

export interface StackCommand {
  kind: "stack";
  sessionSlug: string;
  action: "show" | "restack" | "land-all";
}

export interface CleanCommand {
  kind: "clean";
  sessionSlug: string;
}

export interface DoneCommand {
  kind: "done";
  sessionSlug: string;
}

export interface DagCancelCommand {
  kind: "dag.cancel";
  dagId: string;
}

export interface DagForceLandCommand {
  kind: "dag.force-land";
  dagId: string;
  nodeId: string;
}

export interface ResumeSessionCommand {
  kind: "resume-session";
  sessionSlug: string;
}

export interface UpdateSessionBudgetCommand {
  kind: "update-session-budget";
  slug: string;
  costBudgetUsd: number;
}

export type Command =
  | ReplyCommand
  | StopCommand
  | CloseCommand
  | PlanActionCommand
  | ShipAdvanceCommand
  | LandCommand
  | OpenForReviewCommand
  | RetryRebaseCommand
  | SubmitFeedbackCommand
  | ForceCommand
  | RetryCommand
  | JudgeCommand
  | SplitCommand
  | StackCommand
  | CleanCommand
  | DoneCommand
  | DagCancelCommand
  | DagForceLandCommand
  | ResumeSessionCommand
  | UpdateSessionBudgetCommand;

export type CommandKind = Command["kind"];

export interface CommandResult {
  ok: boolean;
  message?: string;
  data?: unknown;
}
