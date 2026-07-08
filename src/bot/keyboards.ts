import { Markup } from 'telegraf';
import type { BookResult } from '../scraper/types.js';

function formatSize(bytes?: number): string {
  if (!bytes) return '';
  if (bytes >= 1_073_741_824) return ` (${(bytes / 1_073_741_824).toFixed(1)} GB)`;
  if (bytes >= 1_048_576) return ` (${(bytes / 1_048_576).toFixed(1)} MB)`;
  if (bytes >= 1024) return ` (${Math.round(bytes / 1024)} KB)`;
  return '';
}

export function formatResultsList(results: BookResult[]): string {
  return results
    .map((book, i) => {
      const size = formatSize(book.fileSize);
      return `${i + 1}. <b>${escapeHtml(book.title)}</b>\n`
        + `   ${escapeHtml(book.author)} [${book.source}]${size}`;
    })
    .join('\n\n');
}

export function searchResultsKeyboard(results: BookResult[]) {
  const buttons = results.map((book, i) =>
    Markup.button.callback(`${i + 1}`, `download:${book.source}:${book.id}`),
  );

  return Markup.inlineKeyboard(buttons, { columns: 5 });
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
