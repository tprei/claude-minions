import type { Session } from "@minions/shared";
import type { EngineContext } from "../context.js";

export interface WorkstreamInfo {
  rootShipSlug: string;
  rootShipTitle: string;
  nodeIndex: number;
  nodeTotal: number;
  nodeTitle: string;
  dependsOnPrs: number[];
  stacksOnPr: number | null;
}

export function resolveWorkstream(
  ctx: EngineContext,
  session: Session,
): WorkstreamInfo | null {
  if (session.mode !== "dag-task" || !session.dagId) return null;

  const dag = ctx.dags.get(session.dagId);
  if (!dag) return null;

  const metadataNodeId =
    typeof session.metadata?.dagNodeId === "string"
      ? (session.metadata.dagNodeId as string)
      : undefined;
  const nodeId = session.dagNodeId ?? metadataNodeId;
  if (!nodeId) return null;

  const nodeIndex = dag.nodes.findIndex((n) => n.id === nodeId);
  if (nodeIndex < 0) return null;
  const node = dag.nodes[nodeIndex]!;

  if (!dag.rootSessionSlug) return null;
  const rootShipSlug = dag.rootSessionSlug;
  const shipSession = ctx.sessions.get(rootShipSlug);
  const rootShipTitle = shipSession?.title ?? dag.title;

  const dependsOnPrs: number[] = [];
  for (const depId of node.dependsOn) {
    const dep = dag.nodes.find((n) => n.id === depId);
    if (dep?.pr?.number) {
      dependsOnPrs.push(dep.pr.number);
    }
  }

  let stacksOnPr: number | null = null;
  if (node.dependsOn.length > 0) {
    const firstDep = dag.nodes.find((n) => n.id === node.dependsOn[0]);
    stacksOnPr = firstDep?.pr?.number ?? null;
  }

  return {
    rootShipSlug,
    rootShipTitle,
    nodeIndex: nodeIndex + 1,
    nodeTotal: dag.nodes.length,
    nodeTitle: node.title,
    dependsOnPrs,
    stacksOnPr,
  };
}
