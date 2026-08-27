// ---------------------------------------------------------------------------
// database.ts  — owns the single better-sqlite3 connection for the app.
// The DB file lives in Electron's userData dir so it survives app updates and
// isn't bundled read-only inside the asar package.
// ---------------------------------------------------------------------------
import { app } from 'electron'
import { join } from 'path'
import Database from 'better-sqlite3'
import {
  SCHEMA_SQL,
  SCHEMA_VERSION,
  MIGRATION_COLUMNS,
  DEFAULT_FOLDER_ID,
  DEFAULT_FOLDER_NAME
} from './schema'
import { DEFAULT_SCENARIO_NAME, DEFAULT_WARMUP_STEPS } from '../../types/scenario'

let db: Database.Database | null = null

export function getDbPath(): string {
  return join(app.getPath('userData'), 'data.sqlite')
}

/** Add any columns missing from an older database (idempotent). */
function runColumnMigrations(database: Database.Database): void {
  for (const { table, column, ddl } of MIGRATION_COLUMNS) {
    const cols = database.prepare(`PRAGMA table_info(${table})`).all() as {
      name: string
    }[]
    if (!cols.some((c) => c.name === column)) {
      try {
        database.exec(ddl)
        console.log(`[db] migrated: added ${table}.${column}`)
      } catch (err) {
        console.error(`[db] migration failed for ${table}.${column}:`, err)
      }
    }
  }
}

/** Ensure the default folder (id 1) exists. */
function seedDefaultFolder(database: Database.Database): void {
  database
    .prepare(
      `INSERT OR IGNORE INTO folders (id, name) VALUES (@id, @name)`
    )
    .run({ id: DEFAULT_FOLDER_ID, name: DEFAULT_FOLDER_NAME })

  // One-time cleanup: rename the legacy default-folder name if present and the
  // new name isn't already taken by another folder.
  const clash = database
    .prepare(`SELECT id FROM folders WHERE name = @name AND id <> @id`)
    .get({ name: DEFAULT_FOLDER_NAME, id: DEFAULT_FOLDER_ID })
  if (!clash) {
    database
      .prepare(
        `UPDATE folders SET name = @name
         WHERE id = @id AND name IN ('Thư mục mặc định')`
      )
      .run({ name: DEFAULT_FOLDER_NAME, id: DEFAULT_FOLDER_ID })
  }

  // Any account with no folder → default folder.
  database
    .prepare(`UPDATE accounts SET folder_id = @id WHERE folder_id IS NULL`)
    .run({ id: DEFAULT_FOLDER_ID })
}

/** Ensure the "Default Warm-up" scenario exists so the builder never starts empty. */
function seedDefaultScenario(database: Database.Database): void {
  database
    .prepare(
      `INSERT OR IGNORE INTO scenarios (name, steps_json, is_default) VALUES (@name, @steps, 1)`
    )
    .run({ name: DEFAULT_SCENARIO_NAME, steps: JSON.stringify(DEFAULT_WARMUP_STEPS) })
}

/** Open (or create) the database and apply the schema. Call once at startup. */
export function initDatabase(): Database.Database {
  if (db) return db

  const file = getDbPath()
  db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA_SQL)

  runColumnMigrations(db)
  // Safe now that is_deleted definitely exists (added above if this DB predates it).
  db.exec(`CREATE INDEX IF NOT EXISTS idx_accounts_is_deleted ON accounts(is_deleted)`)
  seedDefaultFolder(db)
  seedDefaultScenario(db)

  // Record / advance schema version for future migrations.
  const upsert = db.prepare(
    `INSERT INTO settings (key, value) VALUES ('schema_version', @v)
     ON CONFLICT(key) DO UPDATE SET value = @v`
  )
  upsert.run({ v: String(SCHEMA_VERSION) })

  console.log(`[db] opened at ${file} (schema v${SCHEMA_VERSION})`)
  return db
}

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialised — call initDatabase() first')
  return db
}

export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
  }
}
