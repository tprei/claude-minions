import type { FastifyInstance } from "fastify";
import type { EngineContext } from "../context.js";
import type { SubsystemDeps, SubsystemResult } from "../wiring.js";
import { SessionRegistry } from "./registry.js";
import { registerSessionsRoutes } from "./routes.js";

export function createSessionsSubsystem(deps: SubsystemDeps): SubsystemResult<EngineContext["sessions"]> {
  const registry = new SessionRegistry({
    db: deps.db,
    bus: deps.bus,
    log: deps.log,
    workspaceDir: deps.workspaceDir,
    ctx: deps.ctx,
  });

  const api: EngineContext["sessions"] = {
    create: (req) => registry.create(req),
    get: (slug) => registry.get(slug),
    list: () => registry.list(),
    listPaged: (opts) => registry.listPaged(opts),
    listWithTranscript: () => registry.listWithTranscript(),
    transcript: (slug) => registry.transcript(slug),
    stop: (slug, reason) => registry.stop(slug, reason),
    close: (slug, removeWorktree) => registry.close(slug, removeWorktree),
    reply: (slug, text) => registry.reply(slug, text),
    resumeAllActive: () => registry.resumeAllActive(),
    diff: (slug) => registry.diff(slug),
    screenshots: (slug) => Promise.resolve(registry.screenshots_list(slug)),
    screenshotPath: (slug, filename) => registry.screenshotPath(slug, filename),
    checkpoints: (slug) => registry.checkpoints(slug),
    restoreCheckpoint: (slug, id) => registry.restoreCheckpoint(slug, id),
  };

  const registerRoutes = (app: FastifyInstance): void => {
    registerSessionsRoutes(app, deps.ctx);
  };

  const onShutdown = async (): Promise<void> => {
  };

  return { api, registerRoutes, onShutdown };
}
