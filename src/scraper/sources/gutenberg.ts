import axios from 'axios';
import type { BookResult, Source } from '../types.js';

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
    const { data } = await axios.get(`${API_BASE}/books`, {
      params: { search: query },
      timeout: 15_000,
    });

    const books: GutendexBook[] = data.results ?? [];
    return books.slice(0, limit).map((book) => {
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
  }

  async download(book: BookResult): Promise<Buffer> {
    const { data } = await axios.get(book.downloadUrl, {
      responseType: 'arraybuffer',
      timeout: 60_000,
      headers: { 'User-Agent': UA },
    });
    return Buffer.from(data);
  }
}
