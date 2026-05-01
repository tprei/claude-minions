import type { AutomationJob, Session, TranscriptEvent } from "@minions/shared";
import type { EngineContext } from "../../context.js";
import { AutomationJobRepo } from "../../store/repos/automationJobRepo.js";
import type { JobHandler } from "../types.js";

interface VerifyChildPayload {
  sessionSlug: string;
}

export interface VerifyChildHandlerDeps {
  automationRepo: AutomationJobRepo;
}

const TERMINAL_STATUSES: ReadonlySet<Session["status"]> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

function findActiveVerifier(target: Session, ctx: EngineContext): Session | null {
  for (const childSlug of target.childSlugs) {
    const child = ctx.sessions.get(childSlug);
    if (!child) continue;
    if (child.metadata["kind"] !== "verify-child") continue;
    if (TERMINAL_STATUSES.has(child.status)) continue;
    return child;
  }
  return null;
}

export function enqueueVerifyChild(
  repo: AutomationJobRepo,
  sessionSlug: string,
): AutomationJob | null {
  const existing = repo.findByTarget("session", sessionSlug);
  const inFlight = existing.some(
    (j) =>
      j.kind === "verify-child" &&
      (j.status === "pending" || j.status === "running"),
  );
  if (inFlight) return null;
  return repo.enqueue({
    kind: "verify-child",
    targetKind: "session",
    targetId: sessionSlug,
    payload: { sessionSlug },
  });
}

export function buildVerifierPrompt(args: {
  prNumber: number;
  originalTaskPrompt: string;
}): string {
  return [
    "You are a strict, read-only code reviewer. Your sole job is to verify that a PR implements the acceptance criteria from the original task.",
    "",
    "ORIGINAL TASK PROMPT:",
    "---",
    args.originalTaskPrompt,
    "---",
    "",
    `PR TO VERIFY: #${args.prNumber}`,
    "",
    "Inspect the PR using these tools (do NOT modify any files, do NOT push commits):",
    `  gh pr view ${args.prNumber}`,
    `  gh pr diff ${args.prNumber}`,
    `  gh pr checks ${args.prNumber}`,
    "",
    "After inspection, your FINAL chat message MUST start with one of these tokens on its own first line:",
    "",
    "  PASS",
    "  FAIL",
    "",
    "If FAIL, follow with a concise list of specific gaps and a fenced \"```fix-prompt\" block whose body will be sent verbatim to the implementing engineer. Make the fix prompt actionable: name files, describe the missing behavior, and reference the acceptance criteria number it addresses. Do not include the PR number — the engineer is already on the right branch.",
    "",
    "If PASS, you may add a one-line note about what you checked. No fix-prompt block.",
  ].join("\n");
}

export function createVerifyChildSpawnHandler(): JobHandler {
  return async (job: AutomationJob, ctx: EngineContext): Promise<void> => {
    const payload = job.payload as Partial<VerifyChildPayload>;
    const slug = payload.sessionSlug;
    if (typeof slug !== "string" || slug.length === 0) return;

    const session = ctx.sessions.get(slug);
    if (!session) return;
    if (!session.pr || session.pr.state !== "open") return;
    if (session.metadata["kind"] === "verify-child") return;
    if (session.metadata["verifyChildPassed"] === true) return;

    if (findActiveVerifier(session, ctx)) return;

    const prNumber = session.pr.number;
    const prompt = buildVerifierPrompt({
      prNumber,
      originalTaskPrompt: session.prompt,
    });

    try {
      await ctx.sessions.create({
        mode: "verify-child",
        parentSlug: slug,
        title: `verify PR #${prNumber}`,
        prompt,
        repoId: session.repoId,
        baseBranch: session.branch ?? "main",
        metadata: {
          kind: "verify-child",
          forSession: slug,
          prNumber,
        },
      });
    } catch (err) {
      ctx.log.warn("verifyChild: failed to spawn verifier session", {
        slug,
        err: (err as Error).message,
      });
    }
  };
}

export interface VerifierVerdict {
  kind: "pass" | "fail" | "unknown";
  feedback?: string;
}

export function parseVerifierVerdict(events: TranscriptEvent[]): VerifierVerdict {
  let lastAssistantText: string | null = null;
  for (const e of events) {
    if (e.kind === "assistant_text" && typeof e.text === "string" && e.text.trim().length > 0) {
      lastAssistantText = e.text;
    }
  }
  if (!lastAssistantText) return { kind: "unknown" };

  const trimmed = lastAssistantText.trim();
  const firstLineMatch = trimmed.match(/^(PASS|FAIL)\b/);
  if (!firstLineMatch) {
    const tokenMatch = trimmed.match(/(?:^|\n)\s*(PASS|FAIL)\b/);
    if (!tokenMatch) return { kind: "unknown" };
    if (tokenMatch[1] === "PASS") return { kind: "pass" };
    return { kind: "fail", feedback: extractFixPrompt(trimmed) };
  }
  if (firstLineMatch[1] === "PASS") return { kind: "pass" };
  return { kind: "fail", feedback: extractFixPrompt(trimmed) };
}

function extractFixPrompt(text: string): string {
  const fenceMatch = text.match(/```\s*fix-prompt\s*\n([\s\S]*?)\n```/);
  if (fenceMatch && fenceMatch[1]) return fenceMatch[1].trim();
  const afterFail = text.replace(/^FAIL\b\s*/, "").trim();
  return afterFail;
}

export function readVerifyChildAttempts(metadata: Record<string, unknown>): number {
  const raw = metadata["verifyChildAttempts"];
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return 0;
  return Math.floor(raw);
}

export const VERIFY_CHILD_MAX_RETRIES = 1;
