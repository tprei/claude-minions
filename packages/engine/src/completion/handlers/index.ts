import type { EngineContext } from "../../context.js";
import type { Logger } from "../../logger.js";
import { CompletionDispatcher, buildCompletionHandlers } from "../dispatcher.js";

export function wireCompletionHandlers(ctx: EngineContext, log: Logger): () => void {
  const dispatcher = new CompletionDispatcher(ctx.bus, log.child({ subsystem: "completion" }));

  const handlers = buildCompletionHandlers(ctx, log);
  for (const handler of handlers) {
    dispatcher.register(handler);
  }

  return dispatcher.wire();
}
