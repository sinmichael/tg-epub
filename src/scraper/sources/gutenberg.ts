import axios from 'axios';
import type { BookResult, Source } from '../types.js';
import { logger } from '../../logger.js';

const API_BASE = 'https://gutendex.com';

interface GutendexBook {
  id: number;
  title: string;
  authors: { name: string; birth_year: number | null; death_year: number | null }[];
  formats: Record<string, string>;
  languages: string[];
  download_count: number;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

export class GutenbergSource implements Source {
  readonly name = 'gutenberg';

  async search(query: string, limit = 10): Promise<BookResult[]> {
    logger.debug({ source: this.name, query, limit }, 'Source search');

    const { data, status } = await axios.get(`${API_BASE}/books`, {
      params: { search: query },
      timeout: 15_000,
      validateStatus: (s) => s < 500,
    });

    if (status !== 200) {
      logger.warn({ source: this.name, status, query }, 'Gutendex API returned non-200');
      return [];
    }

    const books: GutendexBook[] = data.results ?? [];
    const results = books.slice(0, limit).map((book) => {
      const epubUrl = book.formats['application/epub+zip']
        || book.formats['application/octet-stream']
        || '';

      return {
        id: String(book.id),
        title: book.title,
        author: book.authors.map((a) => a.name).join(', ') || 'Unknown',
        source: this.name,
        downloadUrl: epubUrl,
        language: book.languages[0],
        fileSize: undefined,
      };
    }).filter((b) => b.downloadUrl);

    logger.debug({ source: this.name, query, rawCount: books.length, epubCount: results.length }, 'Source search done');
    return results;
  }

  async download(book: BookResult): Promise<Buffer> {
    logger.debug({ source: this.name, bookId: book.id, url: book.downloadUrl }, 'Download starting');

    const { data, status } = await axios.get(book.downloadUrl, {
      responseType: 'arraybuffer',
      timeout: 30_000,
      headers: { 'User-Agent': UA },
      validateStatus: (s) => s < 500,
    });

    if (status !== 200) {
      throw new Error(`Gutenberg download returned status ${status}`);
    }

    const buffer = Buffer.from(data);
    logger.debug({ source: this.name, bookId: book.id, size: buffer.length }, 'Download complete');
    return buffer;
  }
}
