import type {
  DAG,
  DAGNode,
  MergeReadiness,
  QualityReport,
  ReadinessCheck,
  Session,
} from "@minions/shared";

export interface StackReadinessDeps {
  getSession: (slug: string) => Session | null;
  findDagByRootSession: (slug: string) => DAG | null;
  getQualityReport: (slug: string) => QualityReport | null;
}

interface NodeAssessment {
  node: DAGNode;
  ok: boolean;
  detail: string;
}

function assessNode(node: DAGNode, deps: StackReadinessDeps): NodeAssessment {
  if (!node.sessionSlug) {
    return { node, ok: false, detail: "no child session for node" };
  }

  const child = deps.getSession(node.sessionSlug);
  if (!child) {
    return { node, ok: false, detail: `child session ${node.sessionSlug} not found` };
  }

  if (!child.pr) {
    return { node, ok: false, detail: "child has no PR" };
  }
  if (child.pr.state !== "open") {
    return { node, ok: false, detail: `PR is ${child.pr.state}` };
  }

  const attentionKinds = new Set(child.attention.map((a) => a.kind));
  if (attentionKinds.has("rebase_conflict")) {
    return { node, ok: false, detail: "rebase conflict on child" };
  }
  if (attentionKinds.has("ci_failed")) {
    return { node, ok: false, detail: "CI failed on child" };
  }
  if (attentionKinds.has("ci_pending")) {
    return { node, ok: false, detail: "CI pending on child" };
  }
  if (!attentionKinds.has("ci_passed")) {
    return { node, ok: false, detail: "no CI signal on child" };
  }

  const quality = deps.getQualityReport(child.slug);
  if (quality && quality.status !== "passed") {
    return { node, ok: false, detail: `quality ${quality.status}` };
  }

  return { node, ok: true, detail: "ready" };
}

export function computeStackReadiness(slug: string, deps: StackReadinessDeps): MergeReadiness {
  const session = deps.getSession(slug);
  const computedAt = new Date().toISOString();

  if (!session) {
    return {
      sessionSlug: slug,
      status: "unknown",
      checks: [
        { id: "stack", label: "Stack readiness", status: "unknown", detail: "session not found" },
      ],
      computedAt,
    };
  }

  if (session.mode !== "ship") {
    return {
      sessionSlug: slug,
      status: "unknown",
      checks: [
        { id: "stack", label: "Stack readiness", status: "unknown", detail: "session is not in ship mode" },
      ],
      computedAt,
    };
  }

  const dag = deps.findDagByRootSession(slug);
  if (!dag) {
    return {
      sessionSlug: slug,
      status: "pending",
      checks: [
        { id: "stack", label: "Stack readiness", status: "pending", detail: "no DAG bound to ship session" },
      ],
      computedAt,
    };
  }

  if (dag.nodes.length === 0) {
    return {
      sessionSlug: slug,
      status: "pending",
      checks: [
        { id: "stack", label: "Stack readiness", status: "pending", detail: "DAG has no nodes" },
      ],
      computedAt,
    };
  }

  const assessments = dag.nodes.map((node) => assessNode(node, deps));
  const nodeChecks: ReadinessCheck[] = assessments.map((a) => ({
    id: `node:${a.node.id}`,
    label: `Node ${a.node.title}`,
    status: a.ok ? "ok" : "pending",
    detail: a.ok ? undefined : a.detail,
  }));

  const firstFailing = assessments.find((a) => !a.ok);
  if (!firstFailing) {
    return {
      sessionSlug: slug,
      status: "ready",
      checks: [
        { id: "stack", label: "Stack readiness", status: "ok" },
        ...nodeChecks,
      ],
      computedAt,
    };
  }

  return {
    sessionSlug: slug,
    status: "pending",
    checks: [
      {
        id: "stack",
        label: "Stack readiness",
        status: "pending",
        detail: `Node "${firstFailing.node.title}" not ready: ${firstFailing.detail}`,
      },
      ...nodeChecks,
    ],
    computedAt,
  };
}
