import type { EngineContext } from "../context.js";
import type { Logger } from "../logger.js";

const DEFAULT_RUBRIC = "Favor correctness first, then minimality, then clarity.";

interface JudgeResult {
  chosenSlug: string;
  rationale: string;
}

function extractSummary(ctx: EngineContext, slug: string): string {
  const events = ctx.sessions.transcript(slug);
  const assistantTexts = events
    .filter((e) => e.kind === "assistant_text" && !(e as { partial?: boolean }).partial)
    .slice(-3)
    .map((e) => (e as { text: string }).text)
    .join("\n---\n");
  return assistantTexts || "(no output)";
}

function buildJudgePrompt(
  variants: { slug: string; summary: string }[],
  rubric: string,
): string {
  const parts = variants.map(
    (v, i) =>
      `## Variant ${i + 1} (slug: ${v.slug})\n\n${v.summary}`,
  );
  return [
    `You are a judge evaluating ${variants.length} variants of an AI agent task.`,
    ``,
    `Rubric: ${rubric}`,
    ``,
    ...parts,
    ``,
    `Based on the rubric, select the best variant. Respond in JSON:`,
    `{"chosenSlug":"<slug>","rationale":"<one sentence reason>"}`,
  ].join("\n");
}

function parseJudgeOutput(text: string, fallbackSlug: string): JudgeResult {
  const match = text.match(/\{[^}]*"chosenSlug"\s*:\s*"([^"]+)"[^}]*"rationale"\s*:\s*"([^"]+)"[^}]*\}/);
  if (match?.[1] && match?.[2]) {
    return { chosenSlug: match[1], rationale: match[2] };
  }
  return { chosenSlug: fallbackSlug, rationale: "Unable to parse judge output; defaulting to first variant." };
}

export async function runJudge(
  ctx: EngineContext,
  parentSlug: string,
  childSlugs: string[],
  rubric: string | undefined,
  log: Logger,
): Promise<void> {
  if (childSlugs.length === 0) {
    log.warn("judge: no child slugs", { parentSlug });
    return;
  }

  const effectiveRubric = rubric ?? (ctx.runtime.effective()["judgeRubricDefault"] as string | undefined) ?? DEFAULT_RUBRIC;

  const variants = childSlugs.map((slug) => ({
    slug,
    summary: extractSummary(ctx, slug),
  }));

  const prompt = buildJudgePrompt(variants, effectiveRubric);

  log.info("judge: running", { parentSlug, variantCount: childSlugs.length });

  let result: JudgeResult;

  try {
    const reviewSession = await ctx.sessions.create({
      mode: "review",
      prompt,
      parentSlug,
      metadata: { variantJudge: true, judgedParent: parentSlug },
    });

    const completionText = await waitForSessionText(ctx, reviewSession.slug);
    result = parseJudgeOutput(completionText, childSlugs[0] ?? parentSlug);
  } catch (err) {
    log.error("judge: review session failed", { parentSlug, err: (err as Error).message });
    result = {
      chosenSlug: childSlugs[0] ?? parentSlug,
      rationale: `Judge session failed: ${(err as Error).message}`,
    };
  }

  const verdict = `Judge verdict: chosen=${result.chosenSlug} | rubric="${effectiveRubric}" | rationale: ${result.rationale}`;
  log.info("judge: verdict", { parentSlug, chosenSlug: result.chosenSlug });

  await ctx.sessions.reply(parentSlug, verdict).catch((err) => {
    log.warn("judge: could not post verdict to parent session", {
      parentSlug,
      err: (err as Error).message,
    });
  });
}

function waitForSessionText(ctx: EngineContext, slug: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      unsubscribe();
      const transcript = ctx.sessions.transcript(slug);
      const texts = transcript
        .filter((e) => e.kind === "assistant_text")
        .map((e) => (e as { text: string }).text)
        .join("\n");
      resolve(texts || "");
    }, 5 * 60 * 1000);

    const unsubscribe = ctx.bus.on("session_updated", (evt) => {
      if (evt.session.slug !== slug) return;
      const status = evt.session.status;
      if (status === "completed" || status === "failed" || status === "cancelled") {
        clearTimeout(timeoutHandle);
        unsubscribe();
        if (status === "failed") {
          reject(new Error(`Review session ${slug} failed`));
          return;
        }
        const transcript = ctx.sessions.transcript(slug);
        const texts = transcript
          .filter((e) => e.kind === "assistant_text")
          .map((e) => (e as { text: string }).text)
          .join("\n");
        resolve(texts);
      }
    });
  });
}
