import type { SidecarClient } from "../client.js";
import type { Rule } from "./index.js";

const STALE_THRESHOLD_MS = 60 * 1000;
const firstSeen = new Map<string, number>();
const warned = new Set<string>();

function key(dagId: string, nodeId: string): string {
  return `${dagId}:${nodeId}`;
}

export const dagStaleReady: Rule = {
  id: "dagStaleReady",
  description:
    "Watchdog: warns when a DAG node sits in 'ready' for more than 60s without a session being spawned for it.",

  async tick(client) {
    const dags = await client.getDags();
    const liveKeys = new Set<string>();

    for (const dag of dags) {
      for (const node of dag.nodes) {
        const k = key(dag.id, node.id);
        if (node.status === "ready" && !node.sessionSlug) {
          liveKeys.add(k);
          const seen = firstSeen.get(k);
          if (!seen) {
            firstSeen.set(k, Date.now());
            continue;
          }
          const elapsed = Date.now() - seen;
          if (elapsed >= STALE_THRESHOLD_MS && !warned.has(k)) {
            warned.add(k);
            client.log.warn("DAG node stuck 'ready' without a session", {
              rule: "dagStaleReady",
              dagId: dag.id,
              nodeId: node.id,
              title: node.title,
              elapsedMs: elapsed,
            });
          }
        }
      }
    }

    for (const k of [...firstSeen.keys()]) {
      if (!liveKeys.has(k)) {
        firstSeen.delete(k);
        warned.delete(k);
      }
    }
  },
};
