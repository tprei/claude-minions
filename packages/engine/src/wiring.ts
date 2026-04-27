import type Database from "better-sqlite3";
import type { EngineContext } from "./context.js";
import type { Logger } from "./logger.js";
import type { EngineEnv } from "./env.js";
import type { EventBus } from "./bus/eventBus.js";
import type { KeyedMutex } from "./util/mutex.js";

export interface SubsystemDeps {
  ctx: EngineContext;
  log: Logger;
  env: EngineEnv;
  db: Database.Database;
  bus: EventBus;
  mutex: KeyedMutex;
  workspaceDir: string;
}

export interface SubsystemResult<T> {
  api: T;
  registerRoutes?: (app: import("fastify").FastifyInstance) => Promise<void> | void;
  onShutdown?: () => Promise<void> | void;
}

export type SubsystemFactory<T> = (deps: SubsystemDeps) => SubsystemResult<T>;
