import type { SessionMode, SessionBucket } from "@minions/shared";

export interface InferBucketInput {
  prompt: string;
  mode?: SessionMode;
  metadata?: Record<string, unknown>;
}

export function inferBucket(input: InferBucketInput): SessionBucket {
  const mode = input.mode ?? "task";

  if (mode === "think") return "think";
  if (mode === "ship") return "ship";
  if (mode === "dag-task") return "dag-task";
  if (mode === "rebase-resolver") return "rebase-resolver";
  if (mode === "loop") return "loop";
  if (mode === "review") return "review";

  if (input.metadata && input.metadata["kind"] === "fix-ci") return "ci-fix";

  const prompt = input.prompt.trimStart();
  if (/^#\d+\s+fix:/i.test(prompt)) return "bug-fix";
  if (/^ship:/i.test(prompt)) return "ship";
  if (/^probe/i.test(prompt)) return "probe";

  const firstWord = (prompt.split(/\s+/, 1)[0] ?? "").toLowerCase().replace(/[:.,]+$/, "");
  if (firstWord === "add" || firstWord === "feat" || firstWord === "feature" || firstWord === "implement") return "feature";
  if (firstWord === "refactor") return "refactor";
  if (firstWord === "fix") return "bug-fix";

  return "other";
}
