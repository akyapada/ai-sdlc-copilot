import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(path.join(config.dataDir, 'uploads'), { recursive: true });

const dbFile = process.env.NODE_ENV === 'test' ? ':memory:' : path.join(config.dataDir, 'sdlc.db');
export const db = new DatabaseSync(dbFile);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
// Re-use compiled statements: every query in the app is a fixed SQL string.
const statementCache = new Map();
const prepare = db.prepare.bind(db);
db.prepare = (sql) => {
  let stmt = statementCache.get(sql);
  if (!stmt) { stmt = prepare(sql); statementCache.set(sql, stmt); }
  return stmt;
};

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('ADMIN','PM','ARCHITECT','DEVELOPER','QA')),
  active INTEGER NOT NULL DEFAULT 1,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS project_members (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, user_id)
);
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('requirements','team')),
  version INTEGER NOT NULL,
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  parsed_json TEXT,
  validation_json TEXT,
  uploaded_by INTEGER REFERENCES users(id),
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK (stage IN ('requirements','architecture','tasks','tests')),
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('IN_REVIEW','APPROVED','REJECTED','SUPERSEDED')),
  source TEXT NOT NULL,
  content_json TEXT NOT NULL,
  critic_json TEXT,
  guardrail_json TEXT,
  evidence_json TEXT,
  changes_json TEXT,
  feedback TEXT,
  based_on_json TEXT,
  engine TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, stage, version)
);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  artifact_id INTEGER NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  reviewer_id INTEGER REFERENCES users(id),
  reviewer_name TEXT,
  decision TEXT NOT NULL CHECK (decision IN ('APPROVED','REJECTED','COMMENT','REGENERATE')),
  comments TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  user_id INTEGER,
  user_email TEXT,
  action TEXT NOT NULL,
  project_id INTEGER,
  entity TEXT,
  entity_id TEXT,
  details_json TEXT,
  ip TEXT
);
CREATE TABLE IF NOT EXISTS integrations (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('ado','jira')),
  config_json TEXT NOT NULL,
  secret_enc TEXT,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, type)
);
CREATE TABLE IF NOT EXISTS sync_items (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  local_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  external_url TEXT,
  synced_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, type, local_id)
);
CREATE INDEX IF NOT EXISTS idx_artifacts_stage ON artifacts(project_id, stage, version);
CREATE INDEX IF NOT EXISTS idx_audit_project ON audit_log(project_id, ts);
`);

export const ROLES = ['ADMIN', 'PM', 'ARCHITECT', 'DEVELOPER', 'QA'];

export function seedUsers() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (count > 0 || !config.seedDemoUsers) return;
  const hash = bcrypt.hashSync(config.demoPassword, 10);
  const insert = db.prepare('INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, ?)');
  const demo = [
    ['admin@demo.local', 'System Admin', 'ADMIN'],
    ['pm@demo.local', 'Pooja (Project Manager)', 'PM'],
    ['architect@demo.local', 'Arun (Architect)', 'ARCHITECT'],
    ['dev@demo.local', 'Asha Rao', 'DEVELOPER'],
    ['qa@demo.local', 'Meera Iyer', 'QA'],
  ];
  for (const [email, name, role] of demo) insert.run(email, name, hash, role);
  console.log(`[db] Seeded demo users (password from DEMO_PASSWORD): ${demo.map((d) => d[0]).join(', ')}`);
}

export const json = {
  parse(text, fallback = null) {
    if (text == null) return fallback;
    try { return JSON.parse(text); } catch { return fallback; }
  },
  str(value) { return value == null ? null : JSON.stringify(value); },
};
