-- Project Work Memory. Only derived structured records are stored; raw conversations are never ingested.

CREATE TABLE IF NOT EXISTS memory_project (
  device_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  project_key TEXT NOT NULL,
  project_name TEXT NOT NULL,
  repo_path TEXT,
  repo_url TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  current_summary TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (device_id, project_id),
  FOREIGN KEY (device_id) REFERENCES devices(device_id)
);

CREATE TABLE IF NOT EXISTS memory_work_event (
  device_id TEXT NOT NULL,
  id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  source TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  source_ref_json TEXT NOT NULL,
  importance REAL NOT NULL DEFAULT 0,
  confidence REAL NOT NULL DEFAULT 0,
  category TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (device_id, id),
  UNIQUE (device_id, fingerprint),
  FOREIGN KEY (device_id, project_id) REFERENCES memory_project(device_id, project_id)
);

CREATE TABLE IF NOT EXISTS memory_decision (
  device_id TEXT NOT NULL,
  id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  project_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  source_event_id TEXT,
  source_ref_json TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (device_id, id),
  UNIQUE (device_id, fingerprint),
  FOREIGN KEY (device_id, project_id) REFERENCES memory_project(device_id, project_id)
);

CREATE TABLE IF NOT EXISTS memory_project_state (
  device_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  current_phase TEXT NOT NULL,
  recent_progress_json TEXT NOT NULL,
  blockers_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  source_event_id TEXT,
  source_ref_json TEXT,
  PRIMARY KEY (device_id, project_id),
  FOREIGN KEY (device_id, project_id) REFERENCES memory_project(device_id, project_id)
);

CREATE TABLE IF NOT EXISTS memory_next_action (
  device_id TEXT NOT NULL,
  id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  project_id TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  source_event_id TEXT,
  source_ref_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (device_id, id),
  UNIQUE (device_id, fingerprint),
  FOREIGN KEY (device_id, project_id) REFERENCES memory_project(device_id, project_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_project_last_seen
  ON memory_project(device_id, last_seen_at);
CREATE INDEX IF NOT EXISTS idx_memory_event_project_time
  ON memory_work_event(device_id, project_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_memory_event_type_time
  ON memory_work_event(device_id, event_type, occurred_at);
CREATE INDEX IF NOT EXISTS idx_memory_decision_project_time
  ON memory_decision(device_id, project_id, valid_from);
CREATE INDEX IF NOT EXISTS idx_memory_action_project_time
  ON memory_next_action(device_id, project_id, created_at);
