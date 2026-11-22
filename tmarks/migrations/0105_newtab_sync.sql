-- 增量同步状态与历史快照。原 newtab_* 表保持不变，用于首次导入。
CREATE TABLE IF NOT EXISTS newtab_sync_state (
  user_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS newtab_sync_history (
  user_id TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, revision)
);
INSERT OR IGNORE INTO schema_migrations (version) VALUES ('0105');
