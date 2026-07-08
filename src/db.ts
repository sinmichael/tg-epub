import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';

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
`);

export default db;
