import type { BookResult, Source } from './types.js';
import { GutenbergSource } from './sources/gutenberg.js';
import { LibgenSource } from './sources/libgen.js';

// Higher number = higher priority when merging duplicates
const sourcePriority = new Map<string, number>([
  ['gutenberg', 2],
  ['libgen', 1],
]);

const sources: Source[] = [
  new GutenbergSource(),
  new LibgenSource(),
];

const sourceMap = new Map<string, Source>(sources.map((s) => [s.name, s]));

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

  for (const book of books) {
    const key = `${normalizeTitle(book.title)}|${normalizeAuthor(book.author)}`;
    const existing = seen.get(key);

    if (!existing) {
      seen.set(key, book);
    } else {
      // Keep the higher-priority source
      const existingPrio = sourcePriority.get(existing.source) ?? 0;
      const incomingPrio = sourcePriority.get(book.source) ?? 0;
      if (incomingPrio > existingPrio) {
        seen.set(key, book);
      }
    }
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
  const active = sourceNames
    ? sourceNames.map((n) => sourceMap.get(n)).filter(Boolean) as Source[]
    : sources;

  const results = await Promise.allSettled(
    active.map((s) => s.search(query, limitPerSource)),
  );

  const books: BookResult[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      books.push(...result.value);
    }
  }

  const sorted = sortByPriority(books);
  return deduplicate(sorted);
}
