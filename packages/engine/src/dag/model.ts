import type Database from "better-sqlite3";
import type { DAG, DAGNode, DAGNodeStatus } from "@minions/shared";
import type { EventBus } from "../bus/eventBus.js";
import { nowIso } from "../util/time.js";
import { newSlug } from "../util/ids.js";

interface DagRow {
  id: string;
  title: string;
  goal: string;
  repo_id: string | null;
  base_branch: string | null;
  root_session_slug: string | null;
  status: string;
  metadata: string;
  created_at: string;
  updated_at: string;
}

interface DagNodeRow {
  id: string;
  dag_id: string;
  title: string;
  prompt: string;
  status: string;
  depends_on: string;
  session_slug: string | null;
  branch: string | null;
  base_branch: string | null;
  pr_number: number | null;
  pr_url: string | null;
  started_at: string | null;
  completed_at: string | null;
  failed_reason: string | null;
  metadata: string;
  ord: number;
}

function rowToNode(row: DagNodeRow): DAGNode {
  return {
    id: row.id,
    title: row.title,
    prompt: row.prompt,
    status: row.status as DAGNodeStatus,
    dependsOn: JSON.parse(row.depends_on) as string[],
    sessionSlug: row.session_slug ?? undefined,
    branch: row.branch ?? undefined,
    baseBranch: row.base_branch ?? undefined,
    pr: row.pr_number && row.pr_url ? { number: row.pr_number, url: row.pr_url } : undefined,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    failedReason: row.failed_reason ?? undefined,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
  };
}

function rowToDag(row: DagRow, nodes: DAGNode[]): DAG {
  return {
    id: row.id,
    title: row.title,
    goal: row.goal,
    repoId: row.repo_id ?? undefined,
    baseBranch: row.base_branch ?? undefined,
    rootSessionSlug: row.root_session_slug ?? undefined,
    nodes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    status: row.status as DAG["status"],
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
  };
}

export class DagRepo {
  private readonly stmtGetDag: Database.Statement;
  private readonly stmtListDags: Database.Statement;
  private readonly stmtInsertDag: Database.Statement;
  private readonly stmtUpdateDag: Database.Statement;
  private readonly stmtListNodes: Database.Statement;
  private readonly stmtGetNode: Database.Statement;
  private readonly stmtGetNodeBySession: Database.Statement;
  private readonly stmtInsertNode: Database.Statement;
  private readonly stmtUpdateNode: Database.Statement;
  private readonly stmtGetDagByRootSession: Database.Statement;
  private readonly stmtGetDagByNodeSession: Database.Statement;
  private readonly stmtMaxOrd: Database.Statement;
  private readonly stmtDeleteNode: Database.Statement;

  constructor(
    private readonly db: Database.Database,
    private readonly bus: EventBus,
  ) {
    this.stmtGetDag = db.prepare(`SELECT * FROM dags WHERE id = ?`);
    this.stmtListDags = db.prepare(`SELECT * FROM dags ORDER BY created_at DESC`);
    this.stmtInsertDag = db.prepare(`
      INSERT INTO dags(id, title, goal, repo_id, base_branch, root_session_slug, status, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.stmtUpdateDag = db.prepare(`
      UPDATE dags SET title = ?, goal = ?, status = ?, metadata = ?, updated_at = ? WHERE id = ?
    `);
    this.stmtListNodes = db.prepare(`SELECT * FROM dag_nodes WHERE dag_id = ? ORDER BY ord ASC`);
    this.stmtGetNode = db.prepare(`SELECT * FROM dag_nodes WHERE id = ?`);
    this.stmtGetNodeBySession = db.prepare(`SELECT * FROM dag_nodes WHERE session_slug = ?`);
    this.stmtInsertNode = db.prepare(`
      INSERT INTO dag_nodes(id, dag_id, title, prompt, status, depends_on, session_slug, branch, base_branch,
        pr_number, pr_url, started_at, completed_at, failed_reason, metadata, ord)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.stmtUpdateNode = db.prepare(`
      UPDATE dag_nodes SET title = ?, prompt = ?, status = ?, depends_on = ?, session_slug = ?,
        branch = ?, base_branch = ?, pr_number = ?, pr_url = ?, started_at = ?, completed_at = ?,
        failed_reason = ?, metadata = ?, ord = ? WHERE id = ?
    `);
    this.stmtGetDagByRootSession = db.prepare(`SELECT * FROM dags WHERE root_session_slug = ?`);
    this.stmtGetDagByNodeSession = db.prepare(`
      SELECT d.* FROM dags d
      INNER JOIN dag_nodes n ON n.dag_id = d.id
      WHERE n.session_slug = ?
      LIMIT 1
    `);
    this.stmtMaxOrd = db.prepare(`SELECT COALESCE(MAX(ord), -1) as max_ord FROM dag_nodes WHERE dag_id = ?`);
    this.stmtDeleteNode = db.prepare(`DELETE FROM dag_nodes WHERE id = ?`);
  }

  private nodesForDag(dagId: string): DAGNode[] {
    return (this.stmtListNodes.all(dagId) as DagNodeRow[]).map(rowToNode);
  }

  get(id: string): DAG | null {
    const row = this.stmtGetDag.get(id) as DagRow | undefined;
    if (!row) return null;
    return rowToDag(row, this.nodesForDag(id));
  }

  list(): DAG[] {
    return (this.stmtListDags.all() as DagRow[]).map((r) => rowToDag(r, this.nodesForDag(r.id)));
  }

  insert(dag: Omit<DAG, "nodes">): DAG {
    const now = nowIso();
    this.stmtInsertDag.run(
      dag.id,
      dag.title,
      dag.goal,
      dag.repoId ?? null,
      dag.baseBranch ?? null,
      dag.rootSessionSlug ?? null,
      dag.status,
      JSON.stringify(dag.metadata),
      now,
      now,
    );
    const full = this.get(dag.id);
    if (!full) throw new Error(`dag not found after insert: ${dag.id}`);
    this.bus.emit({ kind: "dag_created", dag: full });
    return full;
  }

  update(id: string, patch: Partial<Pick<DAG, "title" | "goal" | "status" | "metadata">>): DAG {
    const current = this.get(id);
    if (!current) throw new Error(`dag not found: ${id}`);
    this.stmtUpdateDag.run(
      patch.title ?? current.title,
      patch.goal ?? current.goal,
      patch.status ?? current.status,
      JSON.stringify(patch.metadata ?? current.metadata),
      nowIso(),
      id,
    );
    const updated = this.get(id);
    if (!updated) throw new Error(`dag not found after update: ${id}`);
    this.bus.emit({ kind: "dag_updated", dag: updated });
    return updated;
  }

  listNodes(dagId: string): DAGNode[] {
    return this.nodesForDag(dagId);
  }

  getNode(id: string): DAGNode | null {
    const row = this.stmtGetNode.get(id) as DagNodeRow | undefined;
    if (!row) return null;
    return rowToNode(row);
  }

  getNodeBySession(sessionSlug: string): DAGNode | null {
    const row = this.stmtGetNodeBySession.get(sessionSlug) as DagNodeRow | undefined;
    if (!row) return null;
    return rowToNode(row);
  }

  insertNode(dagId: string, node: Omit<DAGNode, "id">, ord: number): DAGNode {
    const id = newSlug("node");
    this.stmtInsertNode.run(
      id,
      dagId,
      node.title,
      node.prompt,
      node.status,
      JSON.stringify(node.dependsOn),
      node.sessionSlug ?? null,
      node.branch ?? null,
      node.baseBranch ?? null,
      node.pr?.number ?? null,
      node.pr?.url ?? null,
      node.startedAt ?? null,
      node.completedAt ?? null,
      node.failedReason ?? null,
      JSON.stringify(node.metadata),
      ord,
    );
    const inserted = this.getNode(id);
    if (!inserted) throw new Error(`node not found after insert: ${id}`);
    return inserted;
  }

  updateNode(id: string, patch: Partial<DAGNode>): DAGNode {
    const current = this.getNode(id);
    if (!current) throw new Error(`dag node not found: ${id}`);
    const nodeRow = this.stmtGetNode.get(id) as DagNodeRow;
    const dagId = nodeRow.dag_id;
    this.stmtUpdateNode.run(
      patch.title ?? current.title,
      patch.prompt ?? current.prompt,
      patch.status ?? current.status,
      JSON.stringify(patch.dependsOn ?? current.dependsOn),
      patch.sessionSlug !== undefined ? (patch.sessionSlug ?? null) : (current.sessionSlug ?? null),
      patch.branch !== undefined ? (patch.branch ?? null) : (current.branch ?? null),
      patch.baseBranch !== undefined ? (patch.baseBranch ?? null) : (current.baseBranch ?? null),
      patch.pr?.number ?? current.pr?.number ?? null,
      patch.pr?.url ?? current.pr?.url ?? null,
      patch.startedAt !== undefined ? (patch.startedAt ?? null) : (current.startedAt ?? null),
      patch.completedAt !== undefined ? (patch.completedAt ?? null) : (current.completedAt ?? null),
      patch.failedReason !== undefined ? (patch.failedReason ?? null) : (current.failedReason ?? null),
      JSON.stringify(patch.metadata ?? current.metadata),
      nodeRow.ord,
      id,
    );
    const updated = this.getNode(id);
    if (!updated) throw new Error(`node not found after update: ${id}`);
    const dag = this.get(dagId);
    if (dag) {
      this.bus.emit({ kind: "dag_updated", dag });
    }
    return updated;
  }

  deleteNode(id: string): void {
    this.stmtDeleteNode.run(id);
  }

  byRootSession(rootSessionSlug: string): DAG | null {
    const row = this.stmtGetDagByRootSession.get(rootSessionSlug) as DagRow | undefined;
    if (!row) return null;
    return rowToDag(row, this.nodesForDag(row.id));
  }

  byNodeSession(sessionSlug: string): DAG | null {
    const row = this.stmtGetDagByNodeSession.get(sessionSlug) as DagRow | undefined;
    if (!row) return null;
    return rowToDag(row, this.nodesForDag(row.id));
  }

  nextOrd(dagId: string): number {
    const result = this.stmtMaxOrd.get(dagId) as { max_ord: number } | undefined;
    return (result?.max_ord ?? -1) + 1;
  }
}
