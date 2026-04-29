export interface Migration {
  name: string;
  sql: string;
}

const m001_initial: Migration = {
  name: "001_initial",
  sql: `
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE repos (
  id              TEXT PRIMARY KEY,
  label           TEXT NOT NULL,
  remote          TEXT,
  default_branch  TEXT NOT NULL DEFAULT 'main'
) WITHOUT ROWID;

CREATE TABLE sessions (
  slug             TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  prompt           TEXT NOT NULL,
  mode             TEXT NOT NULL,
  status           TEXT NOT NULL,
  ship_stage       TEXT,
  repo_id          TEXT,
  branch           TEXT,
  base_branch      TEXT,
  worktree_path    TEXT,
  parent_slug      TEXT,
  root_slug        TEXT,
  pr_number        INTEGER,
  pr_url           TEXT,
  pr_state         TEXT,
  pr_draft         INTEGER NOT NULL DEFAULT 0,
  pr_base          TEXT,
  pr_head          TEXT,
  pr_title         TEXT,
  attention        TEXT NOT NULL DEFAULT '[]',
  quick_actions    TEXT NOT NULL DEFAULT '[]',
  stats_turns                INTEGER NOT NULL DEFAULT 0,
  stats_input_tokens         INTEGER NOT NULL DEFAULT 0,
  stats_output_tokens        INTEGER NOT NULL DEFAULT 0,
  stats_cache_read_tokens    INTEGER NOT NULL DEFAULT 0,
  stats_cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  stats_cost_usd             REAL NOT NULL DEFAULT 0,
  stats_duration_ms          INTEGER NOT NULL DEFAULT 0,
  stats_tool_calls           INTEGER NOT NULL DEFAULT 0,
  provider         TEXT NOT NULL,
  model_hint       TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  started_at       TEXT,
  completed_at     TEXT,
  last_turn_at     TEXT,
  dag_id           TEXT,
  dag_node_id      TEXT,
  loop_id          TEXT,
  variant_of       TEXT,
  metadata         TEXT NOT NULL DEFAULT '{}'
) WITHOUT ROWID;

CREATE INDEX idx_sessions_status      ON sessions(status);
CREATE INDEX idx_sessions_mode        ON sessions(mode);
CREATE INDEX idx_sessions_parent      ON sessions(parent_slug);
CREATE INDEX idx_sessions_root        ON sessions(root_slug);
CREATE INDEX idx_sessions_dag         ON sessions(dag_id);
CREATE INDEX idx_sessions_loop        ON sessions(loop_id);
CREATE INDEX idx_sessions_variant_of  ON sessions(variant_of);
CREATE INDEX idx_sessions_updated     ON sessions(updated_at DESC);

CREATE TABLE transcript_events (
  id            TEXT PRIMARY KEY,
  session_slug  TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  turn          INTEGER NOT NULL,
  kind          TEXT NOT NULL,
  body          TEXT NOT NULL,
  timestamp     TEXT NOT NULL,
  UNIQUE(session_slug, seq),
  FOREIGN KEY(session_slug) REFERENCES sessions(slug) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX idx_transcript_session_seq ON transcript_events(session_slug, seq);

CREATE TABLE checkpoints (
  id            TEXT PRIMARY KEY,
  session_slug  TEXT NOT NULL,
  reason        TEXT NOT NULL,
  sha           TEXT NOT NULL,
  branch        TEXT NOT NULL,
  message       TEXT NOT NULL,
  turn          INTEGER NOT NULL,
  created_at    TEXT NOT NULL,
  FOREIGN KEY(session_slug) REFERENCES sessions(slug) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX idx_checkpoints_session ON checkpoints(session_slug, created_at DESC);

CREATE TABLE dags (
  id                 TEXT PRIMARY KEY,
  title              TEXT NOT NULL,
  goal               TEXT NOT NULL,
  repo_id            TEXT,
  base_branch        TEXT,
  root_session_slug  TEXT,
  status             TEXT NOT NULL,
  metadata           TEXT NOT NULL DEFAULT '{}',
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE dag_nodes (
  id              TEXT PRIMARY KEY,
  dag_id          TEXT NOT NULL,
  title           TEXT NOT NULL,
  prompt          TEXT NOT NULL,
  status          TEXT NOT NULL,
  depends_on      TEXT NOT NULL DEFAULT '[]',
  session_slug    TEXT,
  branch          TEXT,
  base_branch     TEXT,
  pr_number       INTEGER,
  pr_url          TEXT,
  started_at      TEXT,
  completed_at    TEXT,
  failed_reason   TEXT,
  metadata        TEXT NOT NULL DEFAULT '{}',
  ord             INTEGER NOT NULL,
  FOREIGN KEY(dag_id) REFERENCES dags(id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX idx_dag_nodes_dag    ON dag_nodes(dag_id, ord);
CREATE INDEX idx_dag_nodes_status ON dag_nodes(status);

CREATE TABLE memories (
  id                     TEXT PRIMARY KEY,
  kind                   TEXT NOT NULL,
  status                 TEXT NOT NULL,
  scope                  TEXT NOT NULL,
  repo_id                TEXT,
  pinned                 INTEGER NOT NULL DEFAULT 0,
  title                  TEXT NOT NULL,
  body                   TEXT NOT NULL,
  proposed_by            TEXT,
  proposed_from_session  TEXT,
  reviewed_by            TEXT,
  reviewed_at            TEXT,
  rejection_reason       TEXT,
  supersedes             TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
) WITHOUT ROWID;

CREATE INDEX idx_memories_status ON memories(status);
CREATE INDEX idx_memories_kind   ON memories(kind);
CREATE INDEX idx_memories_scope  ON memories(scope, repo_id);

CREATE TABLE audit_events (
  id          TEXT PRIMARY KEY,
  timestamp   TEXT NOT NULL,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  target_kind TEXT,
  target_id   TEXT,
  detail      TEXT
) WITHOUT ROWID;

CREATE INDEX idx_audit_ts ON audit_events(timestamp DESC);

CREATE TABLE external_tasks (
  id            TEXT PRIMARY KEY,
  source        TEXT NOT NULL,
  external_id   TEXT NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  url           TEXT,
  session_slug  TEXT,
  created_at    TEXT NOT NULL,
  metadata      TEXT NOT NULL DEFAULT '{}',
  UNIQUE(source, external_id)
) WITHOUT ROWID;

CREATE TABLE loops (
  id                    TEXT PRIMARY KEY,
  label                 TEXT NOT NULL,
  prompt                TEXT NOT NULL,
  interval_sec          INTEGER NOT NULL,
  enabled               INTEGER NOT NULL DEFAULT 1,
  model_hint            TEXT,
  repo_id               TEXT,
  base_branch           TEXT,
  jitter_pct            REAL NOT NULL DEFAULT 0.1,
  max_concurrent        INTEGER NOT NULL DEFAULT 1,
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  next_run_at           TEXT,
  last_run_at           TEXT,
  last_session_slug     TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE quality_reports (
  session_slug  TEXT PRIMARY KEY,
  status        TEXT NOT NULL,
  checks        TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  FOREIGN KEY(session_slug) REFERENCES sessions(slug) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE TABLE merge_readiness (
  session_slug  TEXT PRIMARY KEY,
  status        TEXT NOT NULL,
  checks        TEXT NOT NULL,
  computed_at   TEXT NOT NULL,
  FOREIGN KEY(session_slug) REFERENCES sessions(slug) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE TABLE push_subscriptions (
  endpoint    TEXT PRIMARY KEY,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  user_agent  TEXT,
  created_at  TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE runtime_config (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  values_json TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

INSERT INTO runtime_config(id, values_json, updated_at) VALUES (1, '{}', strftime('%Y-%m-%dT%H:%M:%fZ','now'));

CREATE TABLE entrypoints (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  label       TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  secret      TEXT,
  config      TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE session_attachments (
  id            TEXT PRIMARY KEY,
  session_slug  TEXT NOT NULL,
  name          TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  path          TEXT NOT NULL,
  byte_size     INTEGER NOT NULL,
  created_at    TEXT NOT NULL,
  FOREIGN KEY(session_slug) REFERENCES sessions(slug) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE TABLE screenshots (
  id            TEXT PRIMARY KEY,
  session_slug  TEXT NOT NULL,
  filename      TEXT NOT NULL,
  byte_size     INTEGER NOT NULL,
  description   TEXT,
  captured_at   TEXT NOT NULL,
  UNIQUE(session_slug, filename),
  FOREIGN KEY(session_slug) REFERENCES sessions(slug) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE TABLE reply_queue (
  id            TEXT PRIMARY KEY,
  session_slug  TEXT NOT NULL,
  payload       TEXT NOT NULL,
  queued_at     TEXT NOT NULL,
  delivered_at  TEXT
) WITHOUT ROWID;

CREATE INDEX idx_reply_queue_session ON reply_queue(session_slug, queued_at);

CREATE TABLE session_feedback (
  id            TEXT PRIMARY KEY,
  session_slug  TEXT NOT NULL,
  event_id      TEXT,
  rating        TEXT NOT NULL,
  reason        TEXT,
  created_at    TEXT NOT NULL,
  FOREIGN KEY(session_slug) REFERENCES sessions(slug) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE TABLE ship_state (
  session_slug  TEXT PRIMARY KEY,
  stage         TEXT NOT NULL,
  notes         TEXT NOT NULL DEFAULT '[]',
  updated_at    TEXT NOT NULL,
  FOREIGN KEY(session_slug) REFERENCES sessions(slug) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE TABLE provider_state (
  session_slug   TEXT PRIMARY KEY,
  provider       TEXT NOT NULL,
  external_id    TEXT,
  last_seq       INTEGER NOT NULL DEFAULT 0,
  last_turn      INTEGER NOT NULL DEFAULT 0,
  data           TEXT NOT NULL DEFAULT '{}',
  updated_at     TEXT NOT NULL,
  FOREIGN KEY(session_slug) REFERENCES sessions(slug) ON DELETE CASCADE
) WITHOUT ROWID;
`,
};

const m002_reply_queue_state: Migration = {
  name: "002_reply_queue_state",
  sql: `
ALTER TABLE reply_queue ADD COLUMN claim_token TEXT;
ALTER TABLE reply_queue ADD COLUMN claimed_at  TEXT;

CREATE INDEX idx_reply_queue_claim ON reply_queue(claim_token);
`,
};

const m003_session_permission_tier: Migration = {
  name: "003_session_permission_tier",
  sql: `
ALTER TABLE sessions ADD COLUMN permission_tier TEXT;
`,
};

export const migrations: Migration[] = [
  m001_initial,
  m002_reply_queue_state,
  m003_session_permission_tier,
];
