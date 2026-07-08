import * as cheerio from 'cheerio';
import type { BookResult, Source } from '../types.js';
import { httpClient } from '../../transport.js';
import { logger } from '../../logger.js';
import { LibgenSource } from './libgen.js';
import { sleep } from '../utils.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const MIRRORS = [
  'https://annas-archive.gl',
  'https://annas-archive.pk',
];



function parseSize(text: string): number | undefined {
  const match = text.trim().match(/^([\d.]+)\s*MB$/i);
  if (match) return Math.round(Number(match[1]) * 1_048_576);

  const kbMatch = text.trim().match(/^([\d.]+)\s*kB$/i);
  if (kbMatch) return Math.round(Number(kbMatch[1]) * 1024);

  return undefined;
}

function parseSearchPage(html: string, limit: number): BookResult[] {
  const $ = cheerio.load(html);
  const items = $('div.border-b');
  const results: BookResult[] = [];

  items.each((_, el) => {
    const c = $(el);
    const link = c.find('a[href*="/md5/"]').first();
    const href = link.attr('href') || '';
    const md5 = href.match(/\/md5\/([a-f0-9]{32})/)?.[1];

    const title = c.find('a.font-semibold').first().text().trim();
    if (!md5 || !title) return;

    let author = '';
    c.find('span.icon-\\[mdi--user-edit\\]').each((_, s) => {
      const p = $(s).closest('a');
      if (p.length) author = p.text().trim();
    });

    let sizeText = '';
    let language = '';
    c.find('div.text-gray-800').each((_, d) => {
      const t = $(d).text().trim();
      if (!t.includes('\u00b7') && !/\d+\.?\d*\s*MB/.test(t)) return;
      const parts = t.split('\u00b7').map((s) => s.trim());
      language = parts[0]?.replace(/\s*\[.*?]/, '').trim() || '';
      const sp = parts.find((p) => /\d+\.?\d*\s*MB/.test(p));
      if (sp) sizeText = sp;
    });

    if (!author) return;

    results.push({
      id: md5,
      title,
      author,
      source: 'anna',
      downloadUrl: `${MIRRORS[0]}/slow_download/${md5}/0/5`,
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
): Promise<BookResult[] | null> {
  try {
    const { data: html, status } = await httpClient.get(`${baseUrl}/search`, {
      params: { q: query, ext: 'epub' },
      timeout: 20_000,
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      validateStatus: (s) => s < 500,
    });

    if (status !== 200) {
      logger.warn({ mirror: baseUrl, status, query }, 'AA mirror returned non-200');
      return null;
    }

    const results = parseSearchPage(html, limit);
    return results;
  } catch (err: any) {
    if (err.name === 'CanceledError') return null;
    logger.warn({ mirror: baseUrl, err: err.message?.slice(0, 80), query }, 'AA mirror search failed');
    return null;
  }
}

async function trySlowDownload(
  baseUrl: string,
  md5: string,
): Promise<Buffer | null> {
  for (let i = 5; i <= 9; i++) {
    const ua = UA;
    try {
      const { data, status } = await httpClient.get(`${baseUrl}/slow_download/${md5}/0/${i}`, {
        responseType: 'arraybuffer',
        timeout: 30_000,
        headers: { 'User-Agent': ua, Referer: `${baseUrl}/` },
        validateStatus: (s) => s < 500,
      });

      if (status === 200 && data && Buffer.from(data).length > 1000) {
        logger.info({ mirror: baseUrl, md5, server: `slow_${i}` }, 'AA slow download succeeded');
        return Buffer.from(data);
      }

      const body = Buffer.from(data).toString('utf-8', 0, 200);
      if (body.includes('DDoS-Guard') || body.includes('ddos-guard')) {
        logger.warn({ mirror: baseUrl, md5, server: `slow_${i}` }, 'AA slow download blocked by DDoS-Guard');
        return null;
      }

      logger.warn({ mirror: baseUrl, md5, server: `slow_${i}`, status }, 'AA slow download non-200');
    } catch (err: any) {
      if (err.name === 'CanceledError') return null;
      logger.warn({ mirror: baseUrl, err: err.message?.slice(0, 80), md5, server: `slow_${i}` }, 'AA slow download failed');
    }

    await sleep(2000);
  }

  return null;
}

export class AnnaArchiveSource implements Source {
  readonly name = 'anna';
  private libgen = new LibgenSource();

  async search(query: string, limit = 10): Promise<BookResult[]> {
    logger.debug({ source: this.name, query, limit }, 'Source search');

    for (const mirror of MIRRORS) {
      const results = await trySearch(mirror, query, limit);
      if (results && results.length > 0) {
        logger.info({ mirror, query, count: results.length }, 'AA search succeeded');
        return results;
      }
      await sleep(1000);
    }

    logger.warn({ query }, 'All AA mirrors failed for search');
    return [];
  }

  async download(book: BookResult): Promise<Buffer> {
    const md5 = book.id;
    logger.debug({ source: this.name, bookId: md5 }, 'Download starting');

    for (const mirror of MIRRORS) {
      const buf = await trySlowDownload(mirror, md5);
      if (buf) {
        logger.info({ mirror, bookId: md5, size: buf.length }, 'AA download succeeded');
        return buf;
      }
      await sleep(1000);
    }

    logger.info({ bookId: md5 }, 'AA download failed, falling back to LibGen mirrors');
    return this.libgen.download({ ...book, source: 'libgen' });
  }
}
