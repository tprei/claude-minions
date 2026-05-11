import type Database from "better-sqlite3";
import type { Statement } from "better-sqlite3";
import type { PushSubscriptionRecord, SubscriptionRepository } from "../application/subscription-repository.js";
import {
  PUSH_SUBSCRIPTIONS_DDL,
  SQL_DELETE_SUBSCRIPTION,
  SQL_LIST_SUBS_BY_WORKFLOW,
  SQL_UPSERT_SUBSCRIPTION,
} from "./schema.js";

interface SubRow {
  endpoint: string;
  workflow_id: string;
  p256dh: string;
  auth: string;
}

interface WorkflowIdRow {
  workflow_id: string;
}

export class SQLiteSubscriptionRepository implements SubscriptionRepository {
  private readonly stmtUpsert: Statement<[string, string, string, string, string]>;
  private readonly stmtDelete: Statement<[string, string]>;
  private readonly stmtListByWorkflow: Statement<[string], SubRow>;

  constructor(db: Database.Database) {
    db.exec(PUSH_SUBSCRIPTIONS_DDL);
    this.stmtUpsert = db.prepare<[string, string, string, string, string]>(SQL_UPSERT_SUBSCRIPTION);
    this.stmtDelete = db.prepare<[string, string]>(SQL_DELETE_SUBSCRIPTION);
    this.stmtListByWorkflow = db.prepare<[string], SubRow>(SQL_LIST_SUBS_BY_WORKFLOW);
  }

  async upsert(record: PushSubscriptionRecord): Promise<void> {
    this.stmtUpsert.run(
      record.endpoint,
      record.workflowId,
      record.keys.p256dh,
      record.keys.auth,
      new Date().toISOString(),
    );
  }

  async remove(endpoint: string, workflowId: string): Promise<void> {
    this.stmtDelete.run(endpoint, workflowId);
  }

  async listByWorkflow(workflowId: string): Promise<PushSubscriptionRecord[]> {
    return this.stmtListByWorkflow.all(workflowId).map((row) => ({
      endpoint: row.endpoint,
      workflowId: row.workflow_id,
      keys: { p256dh: row.p256dh, auth: row.auth },
    }));
  }
}

export function listDistinctWorkflowIds(db: Database.Database): string[] {
  const rows = db.prepare<[], WorkflowIdRow>("SELECT DISTINCT workflow_id FROM push_subscriptions").all();
  return rows.map((r) => r.workflow_id);
}
