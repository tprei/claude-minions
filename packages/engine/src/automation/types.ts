import type { AutomationJob } from "@minions/shared";
import type { EngineContext } from "../context.js";

export type JobHandler = (job: AutomationJob, ctx: EngineContext) => Promise<void>;
