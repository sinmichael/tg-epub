import * as cheerio from 'cheerio';
import axios from 'axios';
import type { BookResult, Source } from '../types.js';
import { logger } from '../../logger.js';
import { downloadFile } from '../utils.js';

const BASE = 'https://www.fadedpage.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export class FadedpageSource implements Source {
  readonly name = 'fadedpage';

  async search(query: string, limit = 10): Promise<BookResult[]> {
    logger.debug({ source: this.name, query, limit }, 'Source search');

    const { data: html, status } = await axios.post(`${BASE}/showbooks.php`,
      new URLSearchParams({ title: query, sort: 'Automatic' }),
      {
        timeout: 20_000,
        headers: {
          'User-Agent': UA,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        validateStatus: (s) => s < 500,
      },
    );

    if (status !== 200) {
      logger.warn({ source: this.name, status, query }, 'Fadedpage returned non-200');
      return [];
    }

    const $ = cheerio.load(html);
    const results: BookResult[] = [];

    $('div.book').each((_, el) => {
      const c = $(el);
      const link = c.find('a').first();
      const title = link.text().trim();
      const href = link.attr('href') || '';

      const pidMatch = href.match(/[?&]pid=(\d+)/);
      if (!pidMatch || !title) return;

      const pid = pidMatch[1];

      const authorText = c.text();
      const author = authorText.replace(title, '').replace(/by\s*/i, '').trim() || 'Unknown';

      results.push({
        id: pid,
        title,
        author,
        source: this.name,
        downloadUrl: `${BASE}/books/${pid}/${pid}.epub`,
        language: 'en',
      });
    });

    if (results.length === 0) {
      $('p:has(a[href*="pid="])').each((_, el) => {
        const c = $(el);
        c.find('br').replaceWith('\n');
        const text = c.text().trim();
        if (!text) return;

        const link = c.find('a[href*="pid="]').first();
        const href = link.attr('href') || '';
        const pidMatch = href.match(/[?&]pid=(\d+)/);
        if (!pidMatch) return;

        const pid = pidMatch[1];
        const title = link.text().trim();
        const author = text.replace(title, '').replace(/^by\s*/i, '').trim() || 'Unknown';

        results.push({
          id: pid,
          title,
          author,
          source: this.name,
          downloadUrl: `${BASE}/books/${pid}/${pid}.epub`,
          language: 'en',
        });
      });
    }

    logger.debug({ source: this.name, query, count: results.length }, 'Source search done');
    return results.slice(0, limit);
  }

  async download(book: BookResult): Promise<Buffer> {
    return downloadFile(this.name, book.downloadUrl, { headers: { 'User-Agent': UA } });
  }
}
