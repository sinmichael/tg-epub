import { Telegraf, Markup } from 'telegraf';
import { config } from '../config.js';
import { searchAll, getSource, getSources } from '../scraper/registry.js';
import { getUserSources, setUserSources } from '../user-store.js';
import { enqueue } from '../queue.js';
import { createTempDir, cleanupTempDir, writeTempFile, isFileTooLarge } from '../storage.js';
import { searchResultsKeyboard, formatResultsList } from './keyboards.js';
import { cooldownMiddleware, errorHandler } from './middleware.js';

import type { BookResult } from '../scraper/types.js';
const resultCache = new Map<string, BookResult>();

export function createBot(): Telegraf {
  const bot = new Telegraf(config.botToken);

  bot.use(errorHandler());
  bot.use(cooldownMiddleware());

  bot.start((ctx) => {
    return ctx.reply(
      'Welcome! Send /search &lt;query&gt; to find EPUB books.\n'
      + 'Use /source to choose which sources to search.\n'
      + 'Example: /search moby dick',
    );
  });

  bot.command('search', async (ctx) => {
    const query = ctx.message.text.slice('/search'.length).trim();
    if (!query) {
      return ctx.reply('Please provide a search query. Example: /search moby dick');
    }

    const msg = await ctx.reply('Searching...');
    const sources = ctx.from ? getUserSources(ctx.from.id) : null;

    try {
      const results = await searchAll(query, 8, sources ?? undefined);

      if (results.length === 0) {
        return ctx.telegram.editMessageText(
          ctx.chat.id, msg.message_id, undefined,
          'No results found. Try a different query.',
        );
      }

      for (const book of results) {
        resultCache.set(`${book.source}:${book.id}`, book);
      }

      const list = formatResultsList(results);
      const kb = searchResultsKeyboard(results);
      await ctx.telegram.editMessageText(
        ctx.chat.id, msg.message_id, undefined,
        `<b>Found ${results.length} result(s):</b>\n\n${list}`,
        { ...kb, parse_mode: 'HTML' },
      );
    } catch {
      await ctx.telegram.editMessageText(
        ctx.chat.id, msg.message_id, undefined,
        'Search failed. Please try again later.',
      );
    }
  });

  bot.command('source', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const arg = ctx.message.text.slice('/source'.length).trim().toLowerCase();
    const allSources = getSources().map((s) => s.name);

    if (!arg) {
      const current = getUserSources(userId);
      const status = current
        ? `Current sources: ${current.join(', ')}`
        : 'Current sources: all';

      const buttons = allSources.map((name) =>
        Markup.button.callback(
          `${current?.includes(name) ? '✓ ' : ''}${name}`,
          `source:${name}`,
        ),
      );
      buttons.push(Markup.button.callback('All sources', 'source:all'));

      return ctx.reply(status, Markup.inlineKeyboard(buttons));
    }

    if (arg === 'all') {
      setUserSources(userId, null);
      return ctx.reply('Now searching all sources.');
    }

    if (allSources.includes(arg)) {
      setUserSources(userId, [arg]);
      return ctx.reply(`Now searching only ${arg}.`);
    }

    const available = allSources.join(', ');
    return ctx.reply(`Unknown source. Available: ${available}`);
  });

  bot.action(/^source:(.+)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const name = ctx.match[1];
    await ctx.answerCbQuery();

    if (name === 'all') {
      setUserSources(userId, null);
      await ctx.editMessageText('Now searching all sources.');
    } else {
      setUserSources(userId, [name]);
      await ctx.editMessageText(`Now searching only ${name}.`);
    }
  });

  bot.action(/^download:(.+):(.+)$/, async (ctx) => {
    const sourceName = ctx.match[1];
    const bookId = ctx.match[2];

    await ctx.answerCbQuery();

    const book = resultCache.get(`${sourceName}:${bookId}`);
    if (!book) {
      return ctx.editMessageText('Session expired. Please search again.');
    }

    const source = getSource(sourceName);
    if (!source) {
      return ctx.editMessageText('Unknown source.');
    }

    const sizeHint = book.fileSize
      ? ` (${(book.fileSize / 1e6).toFixed(1)} MB)`
      : '';

    await ctx.editMessageText(`Downloading${sizeHint}... please wait.`);

    try {
      await enqueue(async () => {
        const buffer = await source.download(book);

        if (isFileTooLarge(buffer.length)) {
          await ctx.editMessageText(
            `File too large (${(buffer.length / 1e6).toFixed(1)}MB). Telegram limit is ${(config.maxFileSizeBytes / 1e6).toFixed(0)}MB.\n\n`
            + `Direct link: ${book.downloadUrl}`,
          );
          return;
        }

        const tmpDir = createTempDir();
        try {
          const fileName = `${book.title.replace(/[^a-zA-Z0-9 ]/g, '')}.epub`;
          const filePath = writeTempFile(tmpDir, fileName, buffer);

          await ctx.replyWithDocument(
            { source: filePath, filename: fileName },
            { caption: `${book.title}\n${book.author}` },
          );

          await ctx.deleteMessage().catch(() => {});
        } finally {
          cleanupTempDir(tmpDir);
        }
      });
    } catch {
      await ctx.editMessageText('Download failed. The source may be unavailable.');
    }
  });

  return bot;
}
