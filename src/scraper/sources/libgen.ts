import axios from 'axios';
import * as cheerio from 'cheerio';
import type { BookResult, Source } from '../types.js';
import { logger } from '../../logger.js';

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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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

type SearchOutcome =
  | { ok: true; results: BookResult[] }
  | { ok: false; is503: boolean };

async function trySearch(
  baseUrl: string,
  query: string,
  limit: number,
): Promise<SearchOutcome> {
  const ua = randomUA();
  try {
    const { data: html, status } = await axios.get(`${baseUrl}/index.php`, {
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
    return { ok: true, results };
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
): Promise<Buffer | null> {
  const ua = randomUA();
  try {
    const downloadUrl = `${baseUrl}/get.php?md5=${md5}`;

    const { data: html, status: s1 } = await axios.get(downloadUrl, {
      timeout: 20_000,
      headers: { 'User-Agent': ua, Referer: `${baseUrl}/` },
      validateStatus: (s) => s < 500,
    });

    if (s1 !== 200) {
      logger.warn({ mirror: baseUrl, md5, status: s1 }, 'LibGen mirror key page non-200');
      return null;
    }

    const $ = cheerio.load(html);
    const keyLink = $('a[href*="get.php"][href*="md5"][href*="key"]').attr('href');

    if (!keyLink) {
      logger.warn({ mirror: baseUrl, md5 }, 'LibGen mirror key not found');
      return null;
    }

    const fullUrl = keyLink.startsWith('http')
      ? keyLink
      : `${baseUrl}${keyLink.startsWith('/') ? '' : '/'}${keyLink}`;

    const { data, status: s2 } = await axios.get(fullUrl, {
      responseType: 'arraybuffer',
      timeout: 120_000,
      headers: { 'User-Agent': ua, Referer: downloadUrl },
      validateStatus: (s) => s < 500,
    });

    if (s2 !== 200) {
      logger.warn({ mirror: baseUrl, md5, status: s2 }, 'LibGen mirror download non-200');
      return null;
    }

    return Buffer.from(data);
  } catch (err: any) {
    if (err.name === 'CanceledError') return null;
    const is503 = err.message?.includes('503');
    logger.warn({ mirror: baseUrl, err: err.message?.slice(0, 80), md5, is503 }, 'LibGen mirror download failed');
    return null;
  }
}

export class LibgenSource implements Source {
  readonly name = 'libgen';

  async search(query: string, limit = 10): Promise<BookResult[]> {
    logger.debug({ source: this.name, query, limit }, 'Source search');

    const runPass = async (pass: number): Promise<BookResult[] | 'geo-blocked' | 'exhausted'> => {
      let consecutive503 = 0;

      for (const mirror of MIRRORS) {
        const outcome = await trySearch(mirror, query, limit);

        if (outcome.ok) {
          logger.info({ mirror, query, count: outcome.results.length, pass }, 'LibGen search succeeded');
          return outcome.results;
        }

        if (outcome.is503) {
          consecutive503++;
          logger.debug({ mirror, consecutive503, pass }, 'LibGen 503, tracking for geo-block detection');
          if (consecutive503 >= 3) {
            logger.warn({ query, pass }, 'LibGen: 3 consecutive 503s, likely geo-blocked');
            return 'geo-blocked';
          }
        } else {
          consecutive503 = 0;
        }

        await sleep(1000);
      }

      return 'exhausted';
    };

    const first = await runPass(1);
    if (first === 'geo-blocked') {
      logger.warn({ query }, 'LibGen appears geo-blocked, skipping retry');
      return [];
    }
    if (first !== 'exhausted') return first;

    logger.info({ query }, 'LibGen first pass exhausted, retrying with delay');
    await sleep(3000);

    const second = await runPass(2);
    if (second === 'geo-blocked' || second === 'exhausted') {
      logger.warn({ query }, 'All LibGen mirrors failed');
      return [];
    }
    return second;
  }

  async download(book: BookResult): Promise<Buffer> {
    const md5 = book.id;
    logger.debug({ source: this.name, bookId: md5 }, 'Download starting');

    const runPass = async (pass: number): Promise<Buffer | 'geo-blocked' | 'exhausted'> => {
      let consecutive503 = 0;

      for (const mirror of MIRRORS) {
        const buf = await tryDownload(mirror, md5);
        if (buf) {
          logger.info({ mirror, bookId: md5, size: buf.length, pass }, 'LibGen download succeeded');
          return buf;
        }

        consecutive503++;
        if (consecutive503 >= 3) {
          logger.warn({ bookId: md5, pass }, 'LibGen download: 3 consecutive failures, likely geo-blocked');
          return 'geo-blocked';
        }

        await sleep(1000);
      }

      return 'exhausted';
    };

    const first = await runPass(1);
    if (first instanceof Buffer) return first;

    logger.info({ bookId: md5 }, 'LibGen download first pass failed, retrying');
    await sleep(3000);

    const second = await runPass(2);
    if (second instanceof Buffer) return second;

    throw new Error('All LibGen mirrors failed for download');
  }
}
