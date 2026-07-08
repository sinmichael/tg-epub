import axios from 'axios';
import * as cheerio from 'cheerio';
import type { BookResult, Source } from '../types.js';

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
    const { data: html } = await axios.get('https://libgen.li/index.php', {
      params: { req: query, res: Math.min(limit, 25), page: 1, sort: 'def', sortmode: 'ASC' },
      timeout: 20_000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
          + '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      },
    });

    const $ = cheerio.load(html);
    const rows = $('table.table-striped tr').filter((_, el) => $(el).find('td').length === 9);

    const results: BookResult[] = [];

    rows.each((_, row) => {
      const tds = $(row).find('td');

      const titleEl = tds.eq(0).find('a').first();
      const title = titleEl.text().trim();
      const author = tds.eq(1).text().trim();
      const language = tds.eq(4).text().trim() || undefined;
      const ext = tds.eq(7).text().trim().toLowerCase();

      if (ext !== 'epub') return;
      if (!title || !author) return;

      // Find MD5 from mirror links
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

    return results.slice(0, limit);
  }

  async download(book: BookResult): Promise<Buffer> {
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

    // Step 1: get the download page to extract the key
    const { data: html } = await axios.get(book.downloadUrl, {
      timeout: 20_000,
      headers: { 'User-Agent': UA, Referer: 'https://libgen.li/' },
    });

    const $ = cheerio.load(html);
    const keyLink = $('a[href*="get.php"][href*="md5"][href*="key"]').attr('href');

    if (!keyLink) {
      throw new Error('Could not find download key on LibGen page');
    }

    const fullUrl = keyLink.startsWith('http')
      ? keyLink
      : `https://libgen.li${keyLink.startsWith('/') ? '' : '/'}${keyLink}`;

    // Step 2: download with the key
    const { data } = await axios.get(fullUrl, {
      responseType: 'arraybuffer',
      timeout: 120_000,
      headers: { 'User-Agent': UA, Referer: book.downloadUrl },
    });

    return Buffer.from(data);
  }
}
