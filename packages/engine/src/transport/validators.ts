import type { CommandKind } from "../application/commands.js";
import { TRANSITION_KINDS } from "../application/transitions.js";

type AllCommandKind = CommandKind | "continue-task" | "retry-task" | "land-workflow";

export interface ValidationFailure {
  field: string;
  expected: string;
  message: string;
}

export type ValidationResult = { ok: true } | { ok: false; failure: ValidationFailure };

type FieldCheck = {
  path: string;
  check: (v: unknown) => boolean;
  expected: string;
};

function get(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function isNonEmptyString(v: unknown): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

function isSafeId(v: unknown): boolean {
  if (typeof v !== "string" || v.trim().length === 0) return false;
  if (!/^[A-Za-z0-9._:-]+$/.test(v)) return false;
  return v !== "__proto__" && v !== "prototype" && v !== "constructor";
}

function isGitBranchName(v: unknown): boolean {
  if (typeof v !== "string") return false;
  const value = v.trim();
  if (value.length === 0) return false;
  if (value === "@" || value.startsWith("-") || value.startsWith("/") || value.endsWith("/")) return false;
  if (value.includes("..") || value.includes("@{") || value.includes("//")) return false;
  if (value.endsWith(".") || value.endsWith(".lock")) return false;
  if (/[\p{Cc} ~^:?*[\]\\]/u.test(value)) return false;
  return true;
}

function isObject(v: unknown): boolean {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isOptionalObject(v: unknown): boolean {
  return v === undefined || isObject(v);
}

function isArray(v: unknown): boolean {
  return Array.isArray(v);
}

function isStringArray(v: unknown): boolean {
  return Array.isArray(v) && v.every(isSafeId);
}

function isOptionalStringArray(v: unknown): boolean {
  return v === undefined || isStringArray(v);
}

function isTransitionKind(v: unknown): boolean {
  return typeof v === "string" && (TRANSITION_KINDS as readonly string[]).includes(v);
}

function runChecks(body: unknown, checks: FieldCheck[]): ValidationResult {
  for (const { path, check, expected } of checks) {
    const value = get(body, path);
    if (!check(value)) {
      return {
        ok: false,
        failure: {
          field: path,
          expected,
          message: `field "${path}" is required and must be ${expected}`,
        },
      };
    }
  }
  return { ok: true };
}

const BASE_WORKFLOW_ID: FieldCheck = { path: "workflowId", check: isSafeId, expected: "safe non-empty id" };

const COMMAND_CHECKS: { [K in AllCommandKind]: FieldCheck[] } = {
  "transition-task": [
    BASE_WORKFLOW_ID,
    { path: "transition", check: isObject, expected: "object" },
    { path: "transition.kind", check: isTransitionKind, expected: `one of ${TRANSITION_KINDS.join(", ")}` },
    { path: "transition.taskId", check: isSafeId, expected: "safe non-empty id" },
    { path: "transition.now", check: isNonEmptyString, expected: "non-empty string" },
  ],
  "request-restack": [
    BASE_WORKFLOW_ID,
    { path: "input", check: isObject, expected: "object" },
    { path: "input.operationId", check: isSafeId, expected: "safe non-empty id" },
    { path: "input.ancestorId", check: isSafeId, expected: "safe non-empty id" },
    { path: "input.idempotencyKey", check: isNonEmptyString, expected: "non-empty string" },
    { path: "input.now", check: isNonEmptyString, expected: "non-empty string" },
  ],
  "start-restack": [
    BASE_WORKFLOW_ID,
    { path: "operationId", check: isSafeId, expected: "safe non-empty id" },
    { path: "now", check: isNonEmptyString, expected: "non-empty string" },
  ],
  "complete-restack": [
    BASE_WORKFLOW_ID,
    { path: "input", check: isObject, expected: "object" },
    { path: "input.operationId", check: isSafeId, expected: "safe non-empty id" },
    { path: "input.artifactsByTaskId", check: isOptionalObject, expected: "object or undefined" },
    { path: "input.now", check: isNonEmptyString, expected: "non-empty string" },
  ],
  "mark-restack-conflict": [
    BASE_WORKFLOW_ID,
    { path: "operationId", check: isSafeId, expected: "safe non-empty id" },
    { path: "error", check: isNonEmptyString, expected: "non-empty string" },
    { path: "now", check: isNonEmptyString, expected: "non-empty string" },
  ],
  "continue-task": [
    BASE_WORKFLOW_ID,
    { path: "taskId", check: isSafeId, expected: "safe non-empty id" },
    { path: "prompt", check: isNonEmptyString, expected: "non-empty string" },
  ],
  "retry-task": [
    BASE_WORKFLOW_ID,
    { path: "taskId", check: isSafeId, expected: "safe non-empty id" },
    { path: "prompt", check: isNonEmptyString, expected: "non-empty string" },
  ],
  "land-workflow": [
    BASE_WORKFLOW_ID,
  ],
};

const TASK_SPEC_CHECKS: FieldCheck[] = [
  { path: "id", check: isSafeId, expected: "safe non-empty id" },
  { path: "title", check: isNonEmptyString, expected: "non-empty string" },
  { path: "prompt", check: isNonEmptyString, expected: "non-empty string" },
  { path: "dependsOn", check: isOptionalStringArray, expected: "array of safe non-empty ids or undefined" },
];

const WORKFLOW_SPEC_CHECKS: FieldCheck[] = [
  { path: "id", check: isSafeId, expected: "safe non-empty id" },
  { path: "kind", check: isNonEmptyString, expected: "non-empty string" },
  { path: "repoId", check: isNonEmptyString, expected: "non-empty string" },
  { path: "tasks", check: isArray, expected: "array" },
];

export function validateCommand(body: unknown): ValidationResult {
  if (!isObject(body)) {
    return { ok: false, failure: { field: "kind", expected: "string", message: 'field "kind" is required and must be string' } };
  }
  const kind = (body as Record<string, unknown>)["kind"];
  if (typeof kind !== "string" || !(kind in COMMAND_CHECKS)) return { ok: true };
  return runChecks(body, COMMAND_CHECKS[kind as AllCommandKind]);
}

function isPushEndpoint(v: unknown): boolean {
  if (typeof v !== "string") return false;
  try {
    const url = new URL(v);
    if (url.protocol === "https:") return true;
    if (url.protocol === "http:") {
      return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "[::1]";
    }
    return false;
  } catch {
    return false;
  }
}

const PUSH_SUBSCRIBE_CHECKS: FieldCheck[] = [
  { path: "workflowId", check: isNonEmptyString, expected: "non-empty string" },
  { path: "subscription", check: isObject, expected: "object" },
  { path: "subscription.endpoint", check: isPushEndpoint, expected: "endpoint must be https:// (or http://localhost for local development)" },
  { path: "subscription.keys", check: isObject, expected: "object" },
  { path: "subscription.keys.p256dh", check: isNonEmptyString, expected: "non-empty string" },
  { path: "subscription.keys.auth", check: isNonEmptyString, expected: "non-empty string" },
];

const PUSH_UNSUBSCRIBE_CHECKS: FieldCheck[] = [
  { path: "endpoint", check: isNonEmptyString, expected: "non-empty string" },
  { path: "workflowId", check: isNonEmptyString, expected: "non-empty string" },
];

export function validatePushSubscribe(body: unknown): ValidationResult {
  return runChecks(body, PUSH_SUBSCRIBE_CHECKS);
}

export function validatePushUnsubscribe(body: unknown): ValidationResult {
  return runChecks(body, PUSH_UNSUBSCRIBE_CHECKS);
}

const ALERT_SUBSCRIBE_CHECKS: FieldCheck[] = [
  { path: "subscription", check: isObject, expected: "object" },
  { path: "subscription.endpoint", check: isPushEndpoint, expected: "endpoint must be https:// (or http://localhost for local development)" },
  { path: "subscription.keys", check: isObject, expected: "object" },
  { path: "subscription.keys.p256dh", check: isNonEmptyString, expected: "non-empty string" },
  { path: "subscription.keys.auth", check: isNonEmptyString, expected: "non-empty string" },
];

const ALERT_UNSUBSCRIBE_CHECKS: FieldCheck[] = [
  { path: "endpoint", check: isNonEmptyString, expected: "non-empty string" },
];

export function validateAlertSubscribe(body: unknown): ValidationResult {
  return runChecks(body, ALERT_SUBSCRIBE_CHECKS);
}

export function validateAlertUnsubscribe(body: unknown): ValidationResult {
  return runChecks(body, ALERT_UNSUBSCRIBE_CHECKS);
}

export function validateWorkflowSpec(body: unknown): ValidationResult {
  const topLevel = runChecks(body, WORKFLOW_SPEC_CHECKS);
  if (!topLevel.ok) return topLevel;

  const tasks = (body as Record<string, unknown>)["tasks"] as unknown[];
  if (tasks.length === 0) {
    return {
      ok: false,
      failure: {
        field: "tasks",
        expected: "non-empty array",
        message: 'field "tasks" must contain at least one task',
      },
    };
  }

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    for (const { path, check, expected } of TASK_SPEC_CHECKS) {
      const value = get(task, path);
      if (!check(value)) {
        const qualifiedPath = `tasks[${i}].${path}`;
        return {
          ok: false,
          failure: {
            field: qualifiedPath,
            expected,
            message: `field "${qualifiedPath}" is required and must be ${expected}`,
          },
        };
      }
    }
    const mergeTarget = get(task, "mergeTarget");
    if (mergeTarget !== undefined && !isGitBranchName(mergeTarget)) {
      const qualifiedPath = `tasks[${i}].mergeTarget`;
      return {
        ok: false,
        failure: {
          field: qualifiedPath,
          expected: "valid git branch name or undefined",
          message: `field "${qualifiedPath}" is required and must be valid git branch name or undefined`,
        },
      };
    }
  }

  const policy = (body as Record<string, unknown>)["policy"];
  if (policy !== undefined) {
    if (!isObject(policy)) {
      return { ok: false, failure: { field: "policy", expected: "object", message: 'field "policy" must be object' } };
    }
    const obj = policy as Record<string, unknown>;
    const maxConcurrent = obj["maxConcurrent"];
    if (
      maxConcurrent !== undefined &&
      (typeof maxConcurrent !== "number" || !Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1)
    ) {
      return { ok: false, failure: { field: "policy.maxConcurrent", expected: "positive safe integer or undefined", message: 'field "policy.maxConcurrent" must be positive safe integer or undefined' } };
    }
    if (obj["autoLand"] !== undefined && typeof obj["autoLand"] !== "boolean") {
      return { ok: false, failure: { field: "policy.autoLand", expected: "boolean or undefined", message: 'field "policy.autoLand" must be boolean or undefined' } };
    }
    if (obj["autoMergeOnGreen"] !== undefined && typeof obj["autoMergeOnGreen"] !== "boolean") {
      return { ok: false, failure: { field: "policy.autoMergeOnGreen", expected: "boolean or undefined", message: 'field "policy.autoMergeOnGreen" must be boolean or undefined' } };
    }
  }

  return { ok: true };
}
