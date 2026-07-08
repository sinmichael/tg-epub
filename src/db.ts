import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';

const dbPath = join(config.dataDir, 'tg-epub.db');

mkdirSync(config.dataDir, { recursive: true });

const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS search_cache (
    query_hash TEXT PRIMARY KEY,
    query TEXT NOT NULL,
    results TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS file_cache (
    source_id TEXT PRIMARY KEY,
    file_path TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS favorites (
    user_id INTEGER NOT NULL,
    source TEXT NOT NULL,
    book_id TEXT NOT NULL,
    title TEXT NOT NULL,
    author TEXT NOT NULL,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, source, book_id)
  );

  CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    source TEXT NOT NULL,
    book_id TEXT NOT NULL,
    title TEXT NOT NULL,
    author TEXT NOT NULL,
    downloaded_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS preferences (
    user_id INTEGER PRIMARY KEY,
    sources TEXT,
    language TEXT DEFAULT '',
    format TEXT DEFAULT 'epub'
  );

  CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER PRIMARY KEY,
    banned INTEGER DEFAULT 0,
    first_seen INTEGER NOT NULL,
    last_active INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS _schema_version (
    version INTEGER PRIMARY KEY
  );
`);

type Migration = { version: number; name: string; up: string };

const migrations: Migration[] = [
  {
    version: 1,
    name: 'history_user_idx',
    up: 'CREATE INDEX IF NOT EXISTS idx_history_user_time ON history(user_id, downloaded_at DESC);',
  },
];

function runMigrations(): void {
  const currentVersion = (db.prepare(
    'SELECT COALESCE(MAX(version), 0) as v FROM _schema_version',
  ).get() as { v: number }).v;

  const pending = migrations.filter((m) => m.version > currentVersion).sort((a, b) => a.version - b.version);

  if (pending.length === 0) {
    logger.debug('No pending database migrations');
    return;
  }

  logger.info({ pending: pending.map((m) => `${m.version}:${m.name}`) }, 'Running database migrations');

  for (const m of pending) {
    db.transaction(() => {
      db.exec(m.up);
      db.prepare('INSERT INTO _schema_version (version) VALUES (?)').run(m.version);
    })();
    logger.info({ version: m.version, name: m.name }, 'Migration applied');
  }
}

runMigrations();

export default db;
