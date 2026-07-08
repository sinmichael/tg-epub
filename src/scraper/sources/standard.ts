import * as cheerio from 'cheerio';
import axios from 'axios';
import type { BookResult, Source } from '../types.js';
import { logger } from '../../logger.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export class StandardEbooksSource implements Source {
  readonly name = 'standard';

  async search(query: string, limit = 10): Promise<BookResult[]> {
    logger.debug({ source: this.name, query, limit }, 'Source search');

    const { data: html, status } = await axios.get('https://standardebooks.org/ebooks', {
      params: { query },
      timeout: 15_000,
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      validateStatus: (s) => s < 500,
    });

    if (status !== 200) {
      logger.warn({ source: this.name, status, query }, 'Standard Ebooks returned non-200');
      return [];
    }

    const $ = cheerio.load(html);
    const results: BookResult[] = [];

    $('li[typeof="schema:Book"]').each((_, el) => {
      const c = $(el);

      const title = c.find('span[property="schema:name"]').first().text().trim();
      if (!title) return;

      const author = c.find('p.author span[property="schema:name"]').first().text().trim()
        || c.find('p.author').first().text().trim()
        || 'Unknown';

      const url = c.find('a[property="schema:url"]').first().attr('href')
        || '';
      if (!url) return;

      const fullUrl = url.startsWith('http') ? url : `https://standardebooks.org${url}`;

      const pathMatch = fullUrl.match(/\/ebooks\/(.+?)\/([^/]+?)\/?$/);
      if (!pathMatch) return;

      const authorSlug = pathMatch[1];
      const titleSlug = pathMatch[2];
      const downloadUrl = `https://standardebooks.org/ebooks/${authorSlug}/${titleSlug}/downloads/${authorSlug}_${titleSlug}.epub`;

      let language = 'en';
      const langEl = c.find('meta[property="schema:inLanguage"]');
      if (langEl.length) {
        language = langEl.attr('content') || 'en';
      }

      results.push({
        id: `${authorSlug}/${titleSlug}`,
        title,
        author,
        source: this.name,
        downloadUrl,
        language,
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
      throw new Error(`Standard Ebooks download returned status ${status}`);
    }

    const buffer = Buffer.from(data);
    logger.debug({ source: this.name, bookId: book.id, size: buffer.length }, 'Download complete');
    return buffer;
  }
}
