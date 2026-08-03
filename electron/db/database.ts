import * as path from 'path';
import * as fs from 'fs';

// `better-sqlite3` is a native CJS module. Under CommonJS output we require it
// directly to avoid any interop quirks with default/namespace imports.
const Database = require('better-sqlite3');
import type { Database as DatabaseType } from 'better-sqlite3';

const DB_FILENAME = 'claude-desktop.db';

/**
 * Resolve the migrations directory.
 *
 * In dev: tsc compiles electron/ → dist-electron/ but does NOT copy .sql
 * files, so the migrations live in the source tree at electron/db/migrations/.
 * From the compiled dist-electron/db/database.js, that is ../../electron/db/migrations.
 *
 * In prod: a build step should copy .sql files next to the compiled JS at
 * dist-electron/db/migrations/, so we check the local `migrations` dir first.
 */
const MIGRATIONS_DIR = (() => {
  const local = path.join(__dirname, 'migrations');
  if (fs.existsSync(local)) return local;
  // Dev fallback — relative to the compiled output directory.
  return path.join(__dirname, '..', '..', 'electron', 'db', 'migrations');
})();

/**
 * Thin wrapper around a better-sqlite3 database handle.
 *
 * Responsibilities:
 *   - Open the database file inside Electron's userData directory.
 *   - Enable WAL journal mode for concurrent read/write performance.
 *   - Run SQL migration files from electron/db/migrations/ in order.
 *   - Provide access to the raw Database instance for repositories.
 */
export class AppDatabase {
  private db: DatabaseType | null = null;

  /** Open the database and run migrations. Must be called before `instance`. */
  initialize(userDataPath: string): void {
    const dbPath = path.join(userDataPath, DB_FILENAME);

    // Ensure the parent directory exists (it should, but be safe).
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const db: DatabaseType = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    this.db = db;

    this.runMigrations();
    this.ensureColumns();
  }

  /** The live database handle. Throws if not initialised. */
  get instance(): DatabaseType {
    if (!this.db) {
      throw new Error('AppDatabase not initialised. Call initialize() first.');
    }
    return this.db;
  }

  /** Close the database handle. Safe to call multiple times. */
  close(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        // ignore close errors during shutdown
      }
      this.db = null;
    }
  }

  // --- migrations ----------------------------------------------------------

  /**
   * Read every `*.sql` file from the migrations directory (sorted) and execute
   * each within its own transaction. better-sqlite3 executes the full script
   * as a prepared statement batch.
   */
  private runMigrations(): void {
    if (!this.db) {
      throw new Error('Database not open.');
    }

    let files: string[];
    try {
      files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
    } catch (err) {
      // If the migrations directory is missing, the schema simply won't be
      // applied. Log but don't crash — callers should still get a working
      // (empty) database.
      console.error('[AppDatabase] Could not read migrations directory:', err);
      return;
    }

    files.sort();

    for (const file of files) {
      const filePath = path.join(MIGRATIONS_DIR, file);
      let sql: string;
      try {
        sql = fs.readFileSync(filePath, 'utf-8');
      } catch (err) {
        console.error(`[AppDatabase] Failed to read migration ${file}:`, err);
        continue;
      }
      if (!sql.trim()) {
        continue;
      }

      try {
        this.db.exec(sql);
      } catch (err) {
        console.error(`[AppDatabase] Migration ${file} failed:`, err);
        throw err;
      }
    }
  }

  /**
   * Idempotent additive-column checks.
   *
   * The migration runner re-executes every *.sql file on each startup (there
   * is no version tracking), so every migration must be idempotent.
   * `CREATE TABLE IF NOT EXISTS` satisfies this, but `ALTER TABLE ADD COLUMN`
   * does not (it throws "duplicate column name" on the second run). Additive
   * columns are therefore ensured here in code instead of via SQL files.
   */
  private ensureColumns(): void {
    if (!this.db) return;
    const cols = this.db.prepare('PRAGMA table_info(messages)').all() as { name: string }[];
    const has = (name: string) => cols.some((c) => c.name === name);
    if (!has('attachments')) {
      this.db.exec('ALTER TABLE messages ADD COLUMN attachments TEXT');
    }
    // conversations.kind distinguishes agent (SDK) vs chat (CLI) conversations.
    const convCols = this.db.prepare('PRAGMA table_info(conversations)').all() as { name: string }[];
    const hasConv = (name: string) => convCols.some((c) => c.name === name);
    if (!hasConv('kind')) {
      this.db.exec("ALTER TABLE conversations ADD COLUMN kind TEXT DEFAULT 'chat'");
    }
  }
}
