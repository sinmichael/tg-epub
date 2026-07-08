import type { BookResult, Source } from './types.js';
import { GutenbergSource } from './sources/gutenberg.js';
import { LibgenSource } from './sources/libgen.js';
// import { AnnaArchiveSource } from './sources/anna.js';
import { StandardEbooksSource } from './sources/standard.js';
import { FadedpageSource } from './sources/fadedpage.js';
import { PlanetEbookSource } from './sources/planetebook.js';
import { getCachedSearch, setCachedSearch } from '../cache.js';
import { logger } from '../logger.js';

const sourcePriority = new Map<string, number>([
  ['libgen', 3],
  // ['anna', 2],
  ['standard', 2],
  ['gutenberg', 1],
  ['fadedpage', 1],
  ['planetebook', 1],
]);

const sources: Source[] = [
  new GutenbergSource(),
  new StandardEbooksSource(),
  new FadedpageSource(),
  new PlanetEbookSource(),
  // new AnnaArchiveSource(),
  new LibgenSource(),
];

const sourceMap = new Map<string, Source>(sources.map((s) => [s.name, s]));

// ── Circuit-breaker ──
interface SourceHealth {
  failCount: number;
  cooldownUntil: number;
}

const healthMap = new Map<string, SourceHealth>();

const COOLDOWN_MS = 5 * 60 * 1000;
const FAIL_THRESHOLD = 3;

function isSourceHealthy(name: string): boolean {
  const h = healthMap.get(name);
  if (!h) return true;
  if (h.cooldownUntil > Date.now()) {
    logger.debug({ source: name, remaining: h.cooldownUntil - Date.now() }, 'Source in cooldown, skipping');
    return false;
  }
  return true;
}

function recordSourceSuccess(name: string): void {
  healthMap.delete(name);
}

function recordSourceFailure(name: string): void {
  const h = healthMap.get(name) ?? { failCount: 0, cooldownUntil: 0 };
  h.failCount++;
  if (h.failCount >= FAIL_THRESHOLD) {
    h.cooldownUntil = Date.now() + COOLDOWN_MS;
    logger.warn({ source: name, cooldownMs: COOLDOWN_MS }, 'Source circuit opened (cooldown)');
  }
  healthMap.set(name, h);
}

export function getSources(): Source[] {
  return sources;
}

export function getSource(name: string): Source | undefined {
  return sourceMap.get(name);
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[:;_-].*$/, '')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeAuthor(author: string): string {
  return author
    .toLowerCase()
    .replace(/[^a-z0-9, ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function deduplicate(books: BookResult[]): BookResult[] {
  const seen = new Map<string, BookResult>();
  let duplicatesRemoved = 0;

  for (const book of books) {
    const key = `${normalizeTitle(book.title)}|${normalizeAuthor(book.author)}`;
    const existing = seen.get(key);

    if (!existing) {
      seen.set(key, book);
    } else {
      duplicatesRemoved++;
      const existingPrio = sourcePriority.get(existing.source) ?? 0;
      const incomingPrio = sourcePriority.get(book.source) ?? 0;
      if (incomingPrio > existingPrio) {
        seen.set(key, book);
      }
    }
  }

  if (duplicatesRemoved > 0) {
    logger.debug({ duplicatesRemoved, totalBefore: books.length, totalAfter: seen.size }, 'Dedup removed entries');
  }

  return [...seen.values()];
}

function sortByPriority(books: BookResult[]): BookResult[] {
  return [...books].sort((a, b) => {
    const pa = sourcePriority.get(a.source) ?? 0;
    const pb = sourcePriority.get(b.source) ?? 0;
    return pb - pa;
  });
}

export async function searchAll(
  query: string,
  limitPerSource = 5,
  sourceNames?: string[],
): Promise<BookResult[]> {
  const nameList = sourceNames?.join(',') || 'all';
  logger.debug({ query, sources: nameList, limitPerSource }, 'Search requested');

  const cached = getCachedSearch(query);
  if (cached) return cached;

  const active = (sourceNames
    ? sourceNames.map((n) => sourceMap.get(n)).filter(Boolean) as Source[]
    : sources)
    .filter((s) => isSourceHealthy(s.name));

  const settled = await Promise.allSettled(
    active.map((s) => s.search(query, limitPerSource)),
  );

  const books: BookResult[] = [];
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    const name = active[i].name;
    if (result.status === 'fulfilled') {
      recordSourceSuccess(name);
      books.push(...result.value);
      logger.debug({ source: name, count: result.value.length }, 'Source search succeeded');
    } else {
      recordSourceFailure(name);
      logger.warn({ source: name, err: result.reason }, 'Source search failed');
    }
  }

  const sorted = sortByPriority(books);
  const deduplicated = deduplicate(sorted);

  logger.info({ query, sources: nameList, rawCount: books.length, finalCount: deduplicated.length }, 'Search complete');

  if (deduplicated.length > 0) {
    setCachedSearch(query, deduplicated);
  } else {
    logger.debug({ query }, 'Skipping cache for empty results');
  }

  return deduplicated;
}
