-- 001-init.sql
-- Initial schema for Claude Code Desktop.

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  project_path TEXT,
  model TEXT NOT NULL,
  pinned INTEGER DEFAULT 0,
  claude_session_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_message TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_conv_pinned ON conversations(pinned);
