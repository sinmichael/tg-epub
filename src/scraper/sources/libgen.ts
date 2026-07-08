import axios from 'axios';
import * as cheerio from 'cheerio';
import type { BookResult, Source } from '../types.js';
import { logger } from '../../logger.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const MIRRORS = [
  'https://libgen.li',
  'https://libgen.is',
  'https://libgen.rs',
  'https://libgen.st',
];

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
  signal?: AbortSignal,
): Promise<BookResult[] | null> {
  try {
    const { data: html, status } = await axios.get(`${baseUrl}/index.php`, {
      params: { req: query, res: Math.min(limit, 25), page: 1, sort: 'def', sortmode: 'ASC' },
      timeout: 15_000,
      headers: { 'User-Agent': UA },
      validateStatus: (s) => s < 500,
      signal,
    });

    if (status !== 200) {
      logger.warn({ mirror: baseUrl, status, query }, 'LibGen mirror returned non-200');
      return null;
    }

    const results = parseSearchPage(html, limit);
    logger.debug({ mirror: baseUrl, query, dataRows: cheerio.load(html)('table.table-striped tr').filter((_, el) => cheerio.load(html)(el).find('td').length === 9).length, epubCount: results.length }, 'LibGen mirror search done');
    return results;
  } catch (err: any) {
    if (err.name === 'CanceledError') return null;
    logger.warn({ mirror: baseUrl, err: err.message, query }, 'LibGen mirror search failed');
    return null;
  }
}

async function tryDownload(
  baseUrl: string,
  md5: string,
  signal?: AbortSignal,
): Promise<Buffer | null> {
  try {
    const downloadUrl = `${baseUrl}/get.php?md5=${md5}`;

    const { data: html, status: s1 } = await axios.get(downloadUrl, {
      timeout: 15_000,
      headers: { 'User-Agent': UA, Referer: `${baseUrl}/` },
      validateStatus: (s) => s < 500,
      signal,
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
      headers: { 'User-Agent': UA, Referer: downloadUrl },
      validateStatus: (s) => s < 500,
      signal,
    });

    if (s2 !== 200) {
      logger.warn({ mirror: baseUrl, md5, status: s2 }, 'LibGen mirror download non-200');
      return null;
    }

    return Buffer.from(data);
  } catch (err: any) {
    if (err.name === 'CanceledError') return null;
    logger.warn({ mirror: baseUrl, err: err.message, md5 }, 'LibGen mirror download failed');
    return null;
  }
}

export class LibgenSource implements Source {
  readonly name = 'libgen';

  async search(query: string, limit = 10): Promise<BookResult[]> {
    logger.debug({ source: this.name, query, limit }, 'Source search');

    for (const mirror of MIRRORS) {
      const results = await trySearch(mirror, query, limit);
      if (results && results.length > 0) {
        logger.info({ mirror, query, count: results.length }, 'LibGen search succeeded on mirror');
        return results;
      }
    }

    logger.warn({ query }, 'All LibGen mirrors failed for search');
    return [];
  }

  async download(book: BookResult): Promise<Buffer> {
    const md5 = book.id;
    logger.debug({ source: this.name, bookId: md5 }, 'Download starting');

    for (const mirror of MIRRORS) {
      const buf = await tryDownload(mirror, md5);
      if (buf) {
        logger.info({ mirror, bookId: md5, size: buf.length }, 'LibGen download succeeded on mirror');
        return buf;
      }
    }

    throw new Error('All LibGen mirrors failed for download');
  }
}
