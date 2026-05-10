import type { Artifact, GraphOperation } from "../domain/types.js";
import type { RestackPlan } from "./restack.js";

export type RestackOutcome =
  | { kind: "completed"; artifactsByTaskId: Record<string, Artifact[]> }
  | { kind: "conflict"; error: string };

export interface RestackExecutor {
  execute(plan: RestackPlan, operation: GraphOperation): Promise<RestackOutcome>;
}

export class NoopRestackExecutor implements RestackExecutor {
  execute(_plan: RestackPlan, _operation: GraphOperation): Promise<RestackOutcome> {
    return Promise.resolve({ kind: "completed", artifactsByTaskId: {} });
  }
}
