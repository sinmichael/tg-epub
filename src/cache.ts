import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import db from './db.js';
import type { BookResult } from './scraper/types.js';

const SEARCH_TTL_MS = 24 * 60 * 60 * 1000;

function queryHash(query: string): string {
  return createHash('sha256').update(query.toLowerCase().trim()).digest('hex').slice(0, 16);
}

export function getCachedSearch(query: string): BookResult[] | null {
  const row = db.prepare(
    'SELECT results, created_at FROM search_cache WHERE query_hash = ?',
  ).get(queryHash(query)) as { results: string; created_at: number } | undefined;

  if (!row) return null;
  if (Date.now() - row.created_at > SEARCH_TTL_MS) {
    db.prepare('DELETE FROM search_cache WHERE query_hash = ?').run(queryHash(query));
    return null;
  }

  return JSON.parse(row.results) as BookResult[];
}

export function setCachedSearch(query: string, results: BookResult[]): void {
  db.prepare(
    'INSERT OR REPLACE INTO search_cache (query_hash, query, results, created_at) VALUES (?, ?, ?, ?)',
  ).run(queryHash(query), query.toLowerCase().trim(), JSON.stringify(results), Date.now());
}

export function getCachedDownload(sourceId: string): string | null {
  const row = db.prepare(
    'SELECT file_path FROM file_cache WHERE source_id = ?',
  ).get(sourceId) as { file_path: string } | undefined;

  if (!row) return null;
  if (!existsSync(row.file_path)) {
    db.prepare('DELETE FROM file_cache WHERE source_id = ?').run(sourceId);
    return null;
  }

  return row.file_path;
}

export function setCachedDownload(sourceId: string, buffer: Buffer): string {
  const dir = join(config.dataDir, 'file-cache');
  const path = join(dir, sourceId.replace(/[^a-zA-Z0-9_-]/g, '_') + '.epub');

  mkdirSync(dir, { recursive: true });
  writeFileSync(path, buffer);

  db.prepare(
    'INSERT OR REPLACE INTO file_cache (source_id, file_path, size, created_at) VALUES (?, ?, ?, ?)',
  ).run(sourceId, path, buffer.length, Date.now());

  return path;
}
