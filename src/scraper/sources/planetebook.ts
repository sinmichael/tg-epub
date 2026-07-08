import * as cheerio from 'cheerio';
import axios from 'axios';
import type { BookResult, Source } from '../types.js';
import { logger } from '../../logger.js';

const BASE = 'https://www.planetebook.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export class PlanetEbookSource implements Source {
  readonly name = 'planetebook';

  async search(query: string, limit = 10): Promise<BookResult[]> {
    logger.debug({ source: this.name, query, limit }, 'Source search');

    const { data: html, status } = await axios.get(BASE, {
      timeout: 15_000,
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      validateStatus: (s) => s < 500,
    });

    if (status !== 200) {
      logger.warn({ source: this.name, status }, 'Planet eBook homepage returned non-200');
      return [];
    }

    const $ = cheerio.load(html);
    const results: BookResult[] = [];
    const q = query.toLowerCase();

    $('p.pelistlinks').each((_, el) => {
      const c = $(el);
      const link = c.find('a').first();
      const href = link.attr('href') || '';
      const title = link.text().trim();
      const slug = href.replace(/\/$/, '').split('/').pop() || '';
      if (!title || !slug) return;
      if (!title.toLowerCase().includes(q) && !slug.includes(q)) return;

      const fullText = c.text();
      let author = 'Unknown';
      const byMatch = fullText.match(/by\s+(.+)$/);
      if (byMatch) {
        author = byMatch[1].trim();
      }

      results.push({
        id: slug,
        title,
        author,
        source: this.name,
        downloadUrl: `${BASE}/free-ebooks/${slug}.epub`,
        language: 'en',
      });
    });

    logger.debug({ source: this.name, query, count: results.length }, 'Source search done');
    return results.slice(0, limit);
  }

  async download(book: BookResult): Promise<Buffer> {
    logger.debug({ source: this.name, bookId: book.id, url: book.downloadUrl }, 'Download starting');

    const { data, status } = await axios.get(book.downloadUrl, {
      responseType: 'arraybuffer',
      timeout: 60_000,
      headers: { 'User-Agent': UA },
      validateStatus: (s) => s < 500,
    });

    if (status !== 200) {
      throw new Error(`Planet eBook download returned status ${status}`);
    }

    const buffer = Buffer.from(data);
    logger.debug({ source: this.name, bookId: book.id, size: buffer.length }, 'Download complete');
    return buffer;
  }
}
