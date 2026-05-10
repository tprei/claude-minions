export const AUDIT_SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  workflow_id TEXT,
  task_id TEXT,
  target_kind TEXT,
  target_id TEXT,
  detail TEXT
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_events(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_workflow ON audit_events(workflow_id, timestamp DESC) WHERE workflow_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_events(action, timestamp DESC);

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('warn','error')),
  message TEXT NOT NULL,
  workflow_id TEXT,
  task_id TEXT,
  detail TEXT
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts(timestamp DESC);

CREATE TABLE IF NOT EXISTS alert_subscriptions (
  endpoint TEXT PRIMARY KEY,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL
) WITHOUT ROWID;
`;

export const SQL_INSERT_AUDIT_EVENT =
  `INSERT OR REPLACE INTO audit_events (id, timestamp, actor, action, workflow_id, task_id, target_kind, target_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

export const SQL_LIST_AUDIT_EVENTS =
  `SELECT id, timestamp, actor, action, workflow_id, task_id, target_kind, target_id, detail FROM audit_events ORDER BY timestamp DESC LIMIT ?`;

export const SQL_LIST_AUDIT_EVENTS_BEFORE =
  `SELECT id, timestamp, actor, action, workflow_id, task_id, target_kind, target_id, detail FROM audit_events WHERE timestamp < ? ORDER BY timestamp DESC LIMIT ?`;

export const SQL_LIST_AUDIT_EVENTS_ACTION =
  `SELECT id, timestamp, actor, action, workflow_id, task_id, target_kind, target_id, detail FROM audit_events WHERE action = ? ORDER BY timestamp DESC LIMIT ?`;

export const SQL_LIST_AUDIT_EVENTS_ACTION_BEFORE =
  `SELECT id, timestamp, actor, action, workflow_id, task_id, target_kind, target_id, detail FROM audit_events WHERE action = ? AND timestamp < ? ORDER BY timestamp DESC LIMIT ?`;

export const SQL_LIST_AUDIT_EVENTS_WORKFLOW =
  `SELECT id, timestamp, actor, action, workflow_id, task_id, target_kind, target_id, detail FROM audit_events WHERE workflow_id = ? ORDER BY timestamp DESC LIMIT ?`;

export const SQL_LIST_AUDIT_EVENTS_WORKFLOW_BEFORE =
  `SELECT id, timestamp, actor, action, workflow_id, task_id, target_kind, target_id, detail FROM audit_events WHERE workflow_id = ? AND timestamp < ? ORDER BY timestamp DESC LIMIT ?`;

export const SQL_INSERT_ALERT =
  `INSERT OR REPLACE INTO alerts (id, timestamp, kind, severity, message, workflow_id, task_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

export const SQL_LIST_ALERTS =
  `SELECT id, timestamp, kind, severity, message, workflow_id, task_id, detail FROM alerts ORDER BY timestamp DESC LIMIT ?`;

export const SQL_LIST_ALERTS_BEFORE =
  `SELECT id, timestamp, kind, severity, message, workflow_id, task_id, detail FROM alerts WHERE timestamp < ? ORDER BY timestamp DESC LIMIT ?`;

export const SQL_UPSERT_ALERT_SUBSCRIPTION =
  `INSERT INTO alert_subscriptions (endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth`;

export const SQL_DELETE_ALERT_SUBSCRIPTION =
  `DELETE FROM alert_subscriptions WHERE endpoint = ?`;

export const SQL_LIST_ALERT_SUBSCRIPTIONS =
  `SELECT endpoint, p256dh, auth FROM alert_subscriptions`;
