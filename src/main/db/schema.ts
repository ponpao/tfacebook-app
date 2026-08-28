// ---------------------------------------------------------------------------
// schema.ts  — DDL executed once on startup to bootstrap the SQLite database.
// Uses IF NOT EXISTS so it's safe to run on every launch (idempotent).
// A small `schema_version` row in `settings` allows future migrations.
// ---------------------------------------------------------------------------

export const SCHEMA_VERSION = 6

/** ID of the auto-seeded default folder. */
export const DEFAULT_FOLDER_ID = 1
export const DEFAULT_FOLDER_NAME = 'Default Folder'

export const SCHEMA_SQL = /* sql */ `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS folders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT UNIQUE NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  uid           TEXT UNIQUE,
  password      TEXT,
  two_fa        TEXT,
  email         TEXT,
  email_pass    TEXT,
  mail_server   TEXT,
  name          TEXT,
  dob           TEXT,
  created_date  TEXT,
  location      TEXT,
  gender        TEXT,
  friends_count INTEGER DEFAULT 0,
  groups_count  INTEGER DEFAULT 0,
  cookie        TEXT,
  token         TEXT,
  proxy         TEXT,
  avatar        TEXT,
  user_agent    TEXT,
  last_active   TEXT,
  status        TEXT DEFAULT 'Unknown',
  status_detail TEXT,
  live_status   TEXT,
  profile_dir   TEXT,
  backup_data   TEXT,
  notes         TEXT,
  folder_id     INTEGER REFERENCES folders(id) ON DELETE SET NULL,
  is_deleted    INTEGER NOT NULL DEFAULT 0,
  deleted_at    DATETIME,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_accounts_status     ON accounts(status);
CREATE INDEX IF NOT EXISTS idx_accounts_email      ON accounts(email);
CREATE INDEX IF NOT EXISTS idx_accounts_folder_id  ON accounts(folder_id);
-- idx_accounts_is_deleted is created after migrations run (see database.ts) —
-- on a pre-existing DB the is_deleted column doesn't exist yet at this point.

-- Keep updated_at fresh on any row change.
CREATE TRIGGER IF NOT EXISTS trg_accounts_updated_at
AFTER UPDATE ON accounts
FOR EACH ROW
BEGIN
  UPDATE accounts SET updated_at = CURRENT_TIMESTAMP WHERE id = OLD.id;
END;

CREATE TABLE IF NOT EXISTS proxies (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  host         TEXT NOT NULL,
  port         INTEGER NOT NULL,
  username     TEXT,
  password     TEXT,
  type         TEXT DEFAULT 'http',
  status       TEXT DEFAULT 'Unknown',
  last_checked DATETIME,
  UNIQUE(host, port, username)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT UNIQUE,
  value TEXT
);

CREATE TABLE IF NOT EXISTS scenarios (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT UNIQUE NOT NULL,
  steps_json TEXT NOT NULL DEFAULT '[]',
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER IF NOT EXISTS trg_scenarios_updated_at
AFTER UPDATE ON scenarios
FOR EACH ROW
BEGIN
  UPDATE scenarios SET updated_at = CURRENT_TIMESTAMP WHERE id = OLD.id;
END;
`

/**
 * Idempotent migrations for databases created before columns/tables existed.
 * better-sqlite3 has no "ADD COLUMN IF NOT EXISTS", so we inspect the schema
 * and add anything missing. Safe to run on every launch.
 */
export const MIGRATION_COLUMNS: { table: string; column: string; ddl: string }[] = [
  { table: 'accounts', column: 'name', ddl: 'ALTER TABLE accounts ADD COLUMN name TEXT' },
  { table: 'accounts', column: 'avatar', ddl: 'ALTER TABLE accounts ADD COLUMN avatar TEXT' },
  {
    table: 'accounts',
    column: 'last_active',
    ddl: 'ALTER TABLE accounts ADD COLUMN last_active TEXT'
  },
  {
    table: 'accounts',
    column: 'live_status',
    ddl: 'ALTER TABLE accounts ADD COLUMN live_status TEXT'
  },
  {
    table: 'accounts',
    column: 'folder_id',
    ddl: 'ALTER TABLE accounts ADD COLUMN folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL'
  },
  {
    table: 'accounts',
    column: 'user_agent',
    ddl: 'ALTER TABLE accounts ADD COLUMN user_agent TEXT'
  },
  {
    table: 'accounts',
    column: 'is_deleted',
    ddl: 'ALTER TABLE accounts ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0'
  },
  {
    table: 'accounts',
    column: 'deleted_at',
    ddl: 'ALTER TABLE accounts ADD COLUMN deleted_at DATETIME'
  },
  // cookie & location back the Cookie / Primary Location grid columns — added
  // to migrations so databases created before these columns existed get them.
  { table: 'accounts', column: 'cookie', ddl: 'ALTER TABLE accounts ADD COLUMN cookie TEXT' },
  { table: 'accounts', column: 'location', ddl: 'ALTER TABLE accounts ADD COLUMN location TEXT' },
  {
    table: 'accounts',
    column: 'groups_count',
    ddl: 'ALTER TABLE accounts ADD COLUMN groups_count INTEGER DEFAULT 0'
  }
]
