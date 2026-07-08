import * as cheerio from 'cheerio';
import type { BookResult, Source } from '../types.js';
import { httpClient } from '../../transport.js';
import { logger } from '../../logger.js';
import { twoPassRetry } from '../utils.js';
import type { AttemptOutcome } from '../utils.js';

const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15',
];

const MIRRORS = [
  'https://libgen.li',
  'https://libgen.bz',
  'https://libgen.gl',
  'https://libgen.is',
  'https://libgen.rs',
  'https://libgen.st',
];

function randomUA(): string {
  return UAS[Math.floor(Math.random() * UAS.length)];
}

function parseSize(text: string): number | undefined {
  const match = text.trim().match(/^([\d.]+)\s*(?:MB|MiB)$/i);
  if (match) return Math.round(Number(match[1]) * 1_048_576);

  const kbMatch = text.trim().match(/^([\d.]+)\s*(?:kB|KiB)$/i);
  if (kbMatch) return Math.round(Number(kbMatch[1]) * 1024);

  const gbMatch = text.trim().match(/^([\d.]+)\s*(?:GB|GiB)$/i);
  if (gbMatch) return Math.round(Number(gbMatch[1]) * 1_073_741_824);

  return undefined;
}

function parseSearchPage(html: string, limit: number): BookResult[] {
  const $ = cheerio.load(html);
  const allRows = $('table.table-striped tr').filter((_, el) => $(el).find('td').length === 9);
  const results: BookResult[] = [];

  allRows.each((_, row) => {
    const tds = $(row).find('td');

    const titleEl = tds.eq(0).find('a').first();
    const title = titleEl.text().trim();
    const author = tds.eq(1).text().trim();
    const language = tds.eq(4).text().trim() || undefined;
    const ext = tds.eq(7).text().trim().toLowerCase();

    if (ext !== 'epub') return;
    if (!title || !author) return;

    const mirrorLinks: string[] = [];
    tds.eq(8).find('a').each((_, a) => {
      const href = $(a).attr('href') ?? '';
      mirrorLinks.push(href);
    });

    const md5Link = mirrorLinks.find((l) => l.includes('md5='));
    const md5Match = md5Link?.match(/md5=([a-f0-9]{32})/i);
    const md5 = md5Match?.[1]?.toLowerCase();
    if (!md5) return;

    const sizeText = tds.eq(6).text().trim();

    results.push({
      id: md5,
      title,
      author,
      source: 'libgen',
      downloadUrl: `${MIRRORS[0]}/get.php?md5=${md5}`,
      fileSize: parseSize(sizeText),
      language,
    });
  });

  return results.slice(0, limit);
}

async function trySearch(
  baseUrl: string,
  query: string,
  limit: number,
): Promise<AttemptOutcome<BookResult[]>> {
  const ua = randomUA();
  try {
    const { data: html, status } = await httpClient.get(`${baseUrl}/index.php`, {
      params: { req: query, res: Math.min(limit, 25), page: 1, sort: 'def', sortmode: 'ASC' },
      timeout: 20_000,
      headers: { 'User-Agent': ua, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      validateStatus: (s) => s < 500,
    });

    if (status !== 200) {
      logger.warn({ mirror: baseUrl, status, query }, 'LibGen mirror returned non-200');
      return { ok: false, is503: status === 503 };
    }

    const results = parseSearchPage(html, limit);
    return { ok: true, value: results };
  } catch (err: any) {
    if (err.name === 'CanceledError') return { ok: false, is503: false };
    const is503 = err.message?.includes('503');
    logger.warn({ mirror: baseUrl, err: err.message?.slice(0, 80), query, is503 }, 'LibGen mirror search failed');
    return { ok: false, is503: !!is503 };
  }
}

async function tryDownload(
  baseUrl: string,
  md5: string,
): Promise<AttemptOutcome<Buffer>> {
  const ua = randomUA();
  try {
    const downloadUrl = `${baseUrl}/get.php?md5=${md5}`;

    const { data: html, status: s1 } = await httpClient.get(downloadUrl, {
      timeout: 20_000,
      headers: { 'User-Agent': ua, Referer: `${baseUrl}/` },
      validateStatus: (s) => s < 500,
    });

    if (s1 !== 200) {
      logger.warn({ mirror: baseUrl, md5, status: s1 }, 'LibGen mirror key page non-200');
      return { ok: false, is503: s1 === 503 };
    }

    const $ = cheerio.load(html);
    const keyLink = $('a[href*="get.php"][href*="md5"][href*="key"]').attr('href');

    if (!keyLink) {
      logger.warn({ mirror: baseUrl, md5 }, 'LibGen mirror key not found');
      return { ok: false, is503: false };
    }

    const fullUrl = keyLink.startsWith('http')
      ? keyLink
      : `${baseUrl}${keyLink.startsWith('/') ? '' : '/'}${keyLink}`;

    const { data, status: s2 } = await httpClient.get(fullUrl, {
      responseType: 'arraybuffer',
      timeout: 60_000,
      headers: { 'User-Agent': ua, Referer: downloadUrl },
      validateStatus: (s) => s < 500,
    });

    if (s2 !== 200) {
      logger.warn({ mirror: baseUrl, md5, status: s2 }, 'LibGen mirror download non-200');
      return { ok: false, is503: s2 === 503 };
    }

    return { ok: true, value: Buffer.from(data) };
  } catch (err: any) {
    if (err.name === 'CanceledError') return { ok: false, is503: false };
    const is503 = err.message?.includes('503');
    logger.warn({ mirror: baseUrl, err: err.message?.slice(0, 80), md5, is503 }, 'LibGen mirror download failed');
    return { ok: false, is503: !!is503 };
  }
}

export class LibgenSource implements Source {
  readonly name = 'libgen';

  async search(query: string, limit = 10): Promise<BookResult[]> {
    logger.debug({ source: this.name, query, limit }, 'Source search');

    try {
      return await twoPassRetry(
        `libgen:search:${query}`,
        MIRRORS,
        (mirror) => trySearch(mirror, query, limit),
      );
    } catch {
      logger.warn({ query }, 'All LibGen mirrors failed for search');
      return [];
    }
  }

  async download(book: BookResult): Promise<Buffer> {
    const md5 = book.id;
    logger.debug({ source: this.name, bookId: md5 }, 'Download starting');

    return twoPassRetry(
      `libgen:download:${md5}`,
      MIRRORS,
      (mirror) => tryDownload(mirror, md5),
      { geoBlockThreshold: 3, delayBetweenMirrors: 1000, delayBetweenPasses: 3000 },
    );
  }
}
