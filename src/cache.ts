import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import db from './db.js';
import { logger } from './logger.js';
import type { BookResult } from './scraper/types.js';

const SEARCH_TTL_MS = 24 * 60 * 60 * 1000;

function queryHash(query: string): string {
  return createHash('sha256').update(query.toLowerCase().trim()).digest('hex').slice(0, 16);
}

export function getCachedSearch(query: string): BookResult[] | null {
  const hash = queryHash(query);
  const row = db.prepare(
    'SELECT results, created_at FROM search_cache WHERE query_hash = ?',
  ).get(hash) as { results: string; created_at: number } | undefined;

  if (!row) {
    logger.debug({ query, hash }, 'Search cache miss');
    return null;
  }

  const age = Date.now() - row.created_at;
  if (age > SEARCH_TTL_MS) {
    logger.debug({ query, hash, ageMs: age }, 'Search cache expired');
    db.prepare('DELETE FROM search_cache WHERE query_hash = ?').run(hash);
    return null;
  }

  logger.debug({ query, hash, ageMs: age }, 'Search cache hit');
  return JSON.parse(row.results) as BookResult[];
}

export function setCachedSearch(query: string, results: BookResult[]): void {
  const hash = queryHash(query);
  logger.debug({ query, hash, count: results.length }, 'Caching search results');
  db.prepare(
    'INSERT OR REPLACE INTO search_cache (query_hash, query, results, created_at) VALUES (?, ?, ?, ?)',
  ).run(hash, query.toLowerCase().trim(), JSON.stringify(results), Date.now());
}

export function getCachedDownload(sourceId: string): string | null {
  const row = db.prepare(
    'SELECT file_path FROM file_cache WHERE source_id = ?',
  ).get(sourceId) as { file_path: string } | undefined;

  if (!row) {
    logger.debug({ sourceId }, 'Download cache miss');
    return null;
  }

  if (!existsSync(row.file_path)) {
    logger.warn({ sourceId, path: row.file_path }, 'Cached file missing from disk, removing entry');
    db.prepare('DELETE FROM file_cache WHERE source_id = ?').run(sourceId);
    return null;
  }

  logger.debug({ sourceId, path: row.file_path }, 'Download cache hit');
  return row.file_path;
}

export function setCachedDownload(sourceId: string, buffer: Buffer): string {
  const dir = join(config.dataDir, 'file-cache');
  const path = join(dir, sourceId.replace(/[^a-zA-Z0-9_-]/g, '_') + '.epub');

  mkdirSync(dir, { recursive: true });
  writeFileSync(path, buffer);

  logger.debug({ sourceId, path, size: buffer.length }, 'Caching downloaded file');

  db.prepare(
    'INSERT OR REPLACE INTO file_cache (source_id, file_path, size, created_at) VALUES (?, ?, ?, ?)',
  ).run(sourceId, path, buffer.length, Date.now());

  return path;
}

export function purgeSearchCache(): number {
  const { changes } = db.prepare('DELETE FROM search_cache').run();
  logger.info({ deletedRows: changes }, 'Search cache purged');
  return changes;
}

export function purgeFileCache(): { dbRows: number; diskFiles: number } {
  const { changes: dbRows } = db.prepare('DELETE FROM file_cache').run();
  const dir = join(config.dataDir, 'file-cache');
  let diskFiles = 0;
  try {
    const files = readdirSync(dir);
    for (const f of files) {
      rmSync(join(dir, f), { force: true });
      diskFiles++;
    }
  } catch {}
  logger.info({ dbRows, diskFiles }, 'File cache purged');
  return { dbRows, diskFiles };
}
