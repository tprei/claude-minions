// Schema definitions for the SQLite-backed repository. Migrations land in a
// sibling file when the schema starts evolving.

export const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  version INTEGER NOT NULL,
  blob TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  workflow_id TEXT NOT NULL,
  cursor INTEGER NOT NULL,
  kind TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (workflow_id, cursor)
);

CREATE TABLE IF NOT EXISTS idempotency (
  workflow_id TEXT NOT NULL,
  key TEXT NOT NULL,
  result_ref TEXT NOT NULL,
  PRIMARY KEY (workflow_id, key)
);

CREATE INDEX IF NOT EXISTS idx_workflows_status ON workflows(status);
`;

export const SQL_GET_WORKFLOW = "SELECT blob FROM workflows WHERE id = ?";
export const SQL_GET_VERSION = "SELECT version FROM workflows WHERE id = ?";
export const SQL_UPSERT_WORKFLOW =
  "INSERT INTO workflows (id, status, version, blob) VALUES (?, ?, ?, ?) " +
  "ON CONFLICT(id) DO UPDATE SET status = excluded.status, version = excluded.version, blob = excluded.blob";
export const SQL_MAX_CURSOR =
  "SELECT COALESCE(MAX(cursor), 0) AS max_cursor FROM events WHERE workflow_id = ?";
export const SQL_INSERT_EVENT =
  "INSERT INTO events (workflow_id, cursor, kind, occurred_at, payload) VALUES (?, ?, ?, ?, ?)";
export const SQL_INSERT_IDEMPOTENCY =
  "INSERT INTO idempotency (workflow_id, key, result_ref) VALUES (?, ?, ?)";
export const SQL_EVENTS_SINCE =
  "SELECT workflow_id, cursor, kind, occurred_at, payload FROM events " +
  "WHERE workflow_id = ? AND cursor > ? ORDER BY cursor";
export const SQL_LOOKUP_IDEMPOTENCY =
  "SELECT result_ref FROM idempotency WHERE workflow_id = ? AND key = ?";
export const SQL_LIST_NON_COMPLETED = "SELECT blob FROM workflows WHERE status != 'completed'";
export const SQL_LIST_COMPLETED = "SELECT blob FROM workflows WHERE status = 'completed'";
export const SQL_LIST_ACTIVE_ORDERED =
  "SELECT blob FROM workflows WHERE status = 'active' ORDER BY json_extract(blob, '$.updatedAt') DESC";
export const SQL_LIST_ALL_ORDERED =
  "SELECT blob FROM workflows ORDER BY json_extract(blob, '$.updatedAt') DESC";

export const PUSH_SUBSCRIPTIONS_DDL = `
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (endpoint, workflow_id)
);
CREATE INDEX IF NOT EXISTS idx_push_subs_workflow ON push_subscriptions(workflow_id);
`;

export const SQL_UPSERT_SUBSCRIPTION =
  "INSERT INTO push_subscriptions (endpoint, workflow_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?) " +
  "ON CONFLICT(endpoint, workflow_id) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth";

export const SQL_DELETE_SUBSCRIPTION = "DELETE FROM push_subscriptions WHERE endpoint = ? AND workflow_id = ?";

export const SQL_LIST_SUBS_BY_WORKFLOW =
  "SELECT endpoint, workflow_id, p256dh, auth FROM push_subscriptions WHERE workflow_id = ?";

export const SQL_LIST_DISTINCT_WORKFLOW_IDS =
  "SELECT DISTINCT workflow_id FROM push_subscriptions";
