import axios from 'axios';
import * as cheerio from 'cheerio';
import type { BookResult, Source } from '../types.js';
import { logger } from '../../logger.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function parseSize(text: string): number | undefined {
  const match = text.trim().match(/^([\d.]+)\s*(?:MB|MiB)$/i);
  if (match) return Math.round(Number(match[1]) * 1_048_576);

  const kbMatch = text.trim().match(/^([\d.]+)\s*(?:kB|KiB)$/i);
  if (kbMatch) return Math.round(Number(kbMatch[1]) * 1024);

  const gbMatch = text.trim().match(/^([\d.]+)\s*(?:GB|GiB)$/i);
  if (gbMatch) return Math.round(Number(gbMatch[1]) * 1_073_741_824);

  return undefined;
}

export class LibgenSource implements Source {
  readonly name = 'libgen';

  async search(query: string, limit = 10): Promise<BookResult[]> {
    logger.debug({ source: this.name, query, limit }, 'Source search');

    const { data: html, status } = await axios.get('https://libgen.li/index.php', {
      params: { req: query, res: Math.min(limit, 25), page: 1, sort: 'def', sortmode: 'ASC' },
      timeout: 20_000,
      headers: { 'User-Agent': UA },
      validateStatus: (s) => s < 500,
    });

    if (status !== 200) {
      logger.warn({ source: this.name, status, query }, 'LibGen search returned non-200');
      return [];
    }

    const $ = cheerio.load(html);
    const allRows = $('table.table-striped tr').filter((_, el) => $(el).find('td').length === 9);
    const dataRows = allRows.length;

    logger.debug({ source: this.name, query, dataRows }, 'LibGen HTML parsed');

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
        source: this.name,
        downloadUrl: `https://libgen.li/get.php?md5=${md5}`,
        fileSize: parseSize(sizeText),
        language,
      });
    });

    logger.debug({ source: this.name, query, epubCount: results.length }, 'Source search done');
    return results.slice(0, limit);
  }

  async download(book: BookResult): Promise<Buffer> {
    logger.debug({ source: this.name, bookId: book.id }, 'Download step 1: fetching key page');

    const { data: html, status: s1 } = await axios.get(book.downloadUrl, {
      timeout: 20_000,
      headers: { 'User-Agent': UA, Referer: 'https://libgen.li/' },
      validateStatus: (s) => s < 500,
    });

    if (s1 !== 200) {
      throw new Error(`LibGen key page returned status ${s1}`);
    }

    const $ = cheerio.load(html);
    const keyLink = $('a[href*="get.php"][href*="md5"][href*="key"]').attr('href');

    if (!keyLink) {
      logger.error({ bookId: book.id, htmlPreview: html.slice(0, 300) }, 'LibGen key not found in page');
      throw new Error('Could not find download key on LibGen page');
    }

    const fullUrl = keyLink.startsWith('http')
      ? keyLink
      : `https://libgen.li${keyLink.startsWith('/') ? '' : '/'}${keyLink}`;

    logger.debug({ source: this.name, bookId: book.id }, 'Download step 2: fetching file with key');

    const { data, status: s2 } = await axios.get(fullUrl, {
      responseType: 'arraybuffer',
      timeout: 120_000,
      headers: { 'User-Agent': UA, Referer: book.downloadUrl },
      validateStatus: (s) => s < 500,
    });

    if (s2 !== 200) {
      throw new Error(`LibGen download returned status ${s2}`);
    }

    const buffer = Buffer.from(data);
    logger.debug({ source: this.name, bookId: book.id, size: buffer.length }, 'Download complete');
    return buffer;
  }
}
