import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export const DATA_DIR = path.resolve(process.env.PLIMSOLL_DATA_DIR || "./data");
export const UPLOAD_DIR = path.join(DATA_DIR, "uploads");

const MIGRATIONS: string[] = [
  `CREATE TABLE users (
     id TEXT PRIMARY KEY,
     email TEXT NOT NULL UNIQUE,
     name TEXT NOT NULL,
     password_hash TEXT,
     is_guest INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL
   );
   CREATE TABLE workspaces (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     plan TEXT NOT NULL DEFAULT 'payg',
     pack_credits INTEGER NOT NULL DEFAULT 3,
     period_start TEXT NOT NULL,
     stripe_customer_id TEXT,
     stripe_subscription_id TEXT,
     settings_json TEXT NOT NULL DEFAULT '{}',
     created_at TEXT NOT NULL
   );
   CREATE TABLE memberships (
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
     role TEXT NOT NULL DEFAULT 'owner',
     PRIMARY KEY (user_id, workspace_id)
   );
   CREATE TABLE sessions (
     id_hash TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
     expires_at TEXT NOT NULL
   );
   CREATE TABLE api_keys (
     id TEXT PRIMARY KEY,
     workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     prefix TEXT NOT NULL,
     key_hash TEXT NOT NULL UNIQUE,
     created_at TEXT NOT NULL,
     last_used_at TEXT
   );
   CREATE TABLE packs (
     id TEXT PRIMARY KEY,
     workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     reference TEXT,
     route TEXT,
     status TEXT NOT NULL DEFAULT 'draft',
     report_json TEXT,
     advice_json TEXT,
     score INTEGER,
     verdict TEXT,
     billed INTEGER NOT NULL DEFAULT 0,
     created_by TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     analyzed_at TEXT
   );
   CREATE INDEX packs_ws ON packs(workspace_id, created_at DESC);
   CREATE TABLE documents (
     id TEXT PRIMARY KEY,
     pack_id TEXT NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
     file_name TEXT NOT NULL,
     mime TEXT NOT NULL,
     size INTEGER NOT NULL,
     storage_path TEXT,
     status TEXT NOT NULL DEFAULT 'queued',
     error TEXT,
     extraction_json TEXT,
     edited INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL
   );
   CREATE INDEX documents_pack ON documents(pack_id);
   CREATE TABLE decisions (
     pack_id TEXT NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
     issue_id TEXT NOT NULL,
     status TEXT NOT NULL,
     note TEXT,
     user_id TEXT,
     decided_at TEXT NOT NULL,
     PRIMARY KEY (pack_id, issue_id)
   );
   CREATE TABLE usage_events (
     id TEXT PRIMARY KEY,
     workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
     pack_id TEXT,
     kind TEXT NOT NULL,
     units INTEGER NOT NULL DEFAULT 1,
     created_at TEXT NOT NULL
   );
   CREATE INDEX usage_ws ON usage_events(workspace_id, created_at);
   CREATE TABLE activity (
     id TEXT PRIMARY KEY,
     pack_id TEXT NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
     user_id TEXT,
     kind TEXT NOT NULL,
     message TEXT NOT NULL,
     created_at TEXT NOT NULL
   );
   CREATE INDEX activity_pack ON activity(pack_id, created_at DESC);`,
];

declare global {
  var __plimsollDb: DatabaseSync | undefined;
}

function open(): DatabaseSync {
  mkdirSync(UPLOAD_DIR, { recursive: true });
  const db = new DatabaseSync(path.join(DATA_DIR, "plimsoll.db"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const row = db.prepare("SELECT MAX(version) AS v FROM _migrations").get() as { v: number | null };
  const current = row.v ?? 0;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]);
      db.prepare("INSERT INTO _migrations (version, applied_at) VALUES (?, ?)").run(v + 1, now());
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  return db;
}

/** Process-wide connection (survives Next.js dev hot reloads). */
export function db(): DatabaseSync {
  if (!globalThis.__plimsollDb) globalThis.__plimsollDb = open();
  return globalThis.__plimsollDb;
}

export function now(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("base64url")}`;
}

export function tx<T>(fn: () => T): T {
  const d = db();
  d.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    d.exec("COMMIT");
    return out;
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}
