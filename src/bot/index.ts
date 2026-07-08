import { Telegraf, Markup } from 'telegraf';
import { config } from '../config.js';
import { searchAll, getSource, getSources } from '../scraper/registry.js';
import { getPrefs, setPrefs, getUserSources, setUserSources } from '../preferences.js';
import { enqueue } from '../queue.js';
import { createTempDir, cleanupTempDir, writeTempFile, isFileTooLarge } from '../storage.js';
import { getCachedDownload, setCachedDownload } from '../cache.js';
import { searchResultsKeyboard, formatResultsList } from './keyboards.js';
import { cooldownMiddleware, errorHandler } from './middleware.js';
import { logger } from '../logger.js';
import db from '../db.js';

import type { BookResult } from '../scraper/types.js';
const resultCache = new Map<string, BookResult>();

function trackUser(userId: number, username?: string): void {
  const now = Date.now();
  const existing = db.prepare('SELECT first_seen FROM users WHERE user_id = ?').get(userId) as { first_seen: number } | undefined;

  db.prepare(`
    INSERT INTO users (user_id, first_seen, last_active) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET last_active = excluded.last_active
  `).run(userId, now, now);

  if (!existing) {
    logger.info({ userId, username }, 'New user');
  }
}

function isBanned(userId: number): boolean {
  const row = db.prepare('SELECT banned FROM users WHERE user_id = ?')
    .get(userId) as { banned: number } | undefined;
  return row?.banned === 1;
}

function isAdmin(userId: number): boolean {
  return config.adminIds.includes(userId);
}

function getAllUserIds(): number[] {
  const rows = db.prepare('SELECT user_id FROM users').all() as { user_id: number }[];
  return rows.map((r) => r.user_id);
}

function addHistory(userId: number, book: BookResult): void {
  db.prepare(`
    INSERT INTO history (user_id, source, book_id, title, author, downloaded_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, book.source, book.id, book.title, book.author, Date.now());
}

function getHistory(userId: number, limit = 10): BookResult[] {
  const rows = db.prepare(`
    SELECT source, book_id, title, author FROM history
    WHERE user_id = ? ORDER BY downloaded_at DESC LIMIT ?
  `).all(userId, limit) as { source: string; book_id: string; title: string; author: string }[];

  return rows.map((r) => ({
    id: r.book_id,
    source: r.source,
    title: r.title,
    author: r.author,
    downloadUrl: '',
  })) as BookResult[];
}

function addFavorite(userId: number, book: BookResult): void {
  db.prepare(`
    INSERT OR IGNORE INTO favorites (user_id, source, book_id, title, author, added_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, book.source, book.id, book.title, book.author, Date.now());
}

function removeFavorite(userId: number, source: string, bookId: string): void {
  db.prepare(
    'DELETE FROM favorites WHERE user_id = ? AND source = ? AND book_id = ?',
  ).run(userId, source, bookId);
}

function getFavorites(userId: number): BookResult[] {
  const rows = db.prepare(`
    SELECT source, book_id, title, author FROM favorites
    WHERE user_id = ? ORDER BY added_at DESC
  `).all(userId) as { source: string; book_id: string; title: string; author: string }[];

  return rows.map((r) => ({
    id: r.book_id,
    source: r.source,
    title: r.title,
    author: r.author,
    downloadUrl: '',
  })) as BookResult[];
}

export function createBot(): Telegraf {
  const bot = new Telegraf(config.botToken);

  bot.use(errorHandler());
  bot.use(cooldownMiddleware());

  bot.use((ctx, next) => {
    if (ctx.from?.id) trackUser(ctx.from.id, ctx.from.username);
    return next();
  });

  bot.start((ctx) => {
    return ctx.reply(
      'Welcome! Send /search &lt;query&gt; to find EPUB books.\n\n'
      + '<b>Commands:</b>\n'
      + '/search &lt;query&gt; — search and download EPUBs\n'
      + '/source — choose which sources to search\n'
      + '/favorites — view your saved books\n'
      + '/history — view recent downloads\n'
      + '/language &lt;code&gt; — filter by language (e.g. en, ru)\n\n'
      + 'Example: /search dune',
      { parse_mode: 'HTML' },
    );
  });

  // ── Search ──
  bot.command('search', async (ctx) => {
    const query = ctx.message.text.slice('/search'.length).trim();
    if (!query) {
      return ctx.reply('Please provide a search query. Example: /search moby dick');
    }

    logger.info({ userId: ctx.from?.id, query }, 'Command: search');

    const msg = await ctx.reply('Searching...');
    const prefs = ctx.from ? getPrefs(ctx.from.id) : { sources: null, language: '', format: 'epub' };

    try {
      const results = await Promise.race([
        searchAll(query, 8, prefs.sources ?? undefined),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Search timed out')), 45_000),
        ),
      ]);

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
    } catch (err) {
      logger.error({ err }, 'Search failed');
      await ctx.telegram.editMessageText(
        ctx.chat.id, msg.message_id, undefined,
        'Search failed. Please try again later.',
      );
    }
  });

  // ── Source ──
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

  // ── Language ──
  bot.command('language', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const arg = ctx.message.text.slice('/language'.length).trim().toLowerCase();
    if (!arg) {
      const prefs = getPrefs(userId);
      const current = prefs.language || 'none (all languages)';
      return ctx.reply(`Current language filter: ${current}\nUsage: /language en`);
    }

    setPrefs(userId, { language: arg });
    return ctx.reply(`Language filter set to: ${arg}`);
  });

  // ── Favorites ──
  bot.command('favorites', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const favs = getFavorites(userId);
    if (favs.length === 0) {
      return ctx.reply('No favorites yet. When you download a book, tap the star to save it.');
    }

    for (const book of favs) {
      resultCache.set(`${book.source}:${book.id}`, book);
    }

    const msg = await ctx.reply(`<b>Your favorites (${favs.length}):</b>\n\n${formatResultsList(favs)}`, {
      parse_mode: 'HTML',
      ...searchResultsKeyboard(favs),
    });
  });

  // ── History ──
  bot.command('history', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const hist = getHistory(userId, 10);
    if (hist.length === 0) {
      return ctx.reply('No download history yet.');
    }

    for (const book of hist) {
      resultCache.set(`${book.source}:${book.id}`, book);
    }

    await ctx.reply(`<b>Recent downloads:</b>\n\n${formatResultsList(hist)}`, {
      parse_mode: 'HTML',
      ...searchResultsKeyboard(hist),
    });
  });

  // ── Download callback ──
  bot.action(/^download:(.+):(.+)$/, async (ctx) => {
    const sourceName = ctx.match[1];
    const bookId = ctx.match[2];

    await ctx.answerCbQuery();

    const book = resultCache.get(`${sourceName}:${bookId}`);
    if (!book) {
      logger.warn({ userId: ctx.from?.id, sourceName, bookId }, 'Download: session expired');
      return ctx.editMessageText('Session expired. Please search again.');
    }

    const source = getSource(sourceName);
    if (!source) {
      logger.warn({ sourceName }, 'Download: unknown source');
      return ctx.editMessageText('Unknown source.');
    }

    if (ctx.from && isBanned(ctx.from.id)) {
      logger.warn({ userId: ctx.from.id }, 'Download: banned user attempted download');
      return ctx.editMessageText('You are banned from using this bot.');
    }

    logger.info({ userId: ctx.from?.id, sourceName, bookId, title: book.title }, 'Download requested');

    const sourceId = `${sourceName}:${bookId}`;
    const cachedPath = getCachedDownload(sourceId);

    if (cachedPath) {
      const { readFileSync } = await import('node:fs');
      const buffer = readFileSync(cachedPath);

      if (isFileTooLarge(buffer.length)) {
        return ctx.editMessageText(
          `File too large (${(buffer.length / 1e6).toFixed(1)}MB). Direct link: ${book.downloadUrl}`,
        );
      }

      const tmpDir = createTempDir();
      try {
        const fileName = `${book.title.replace(/[^a-zA-Z0-9 ]/g, '')}.epub`;
        const filePath = writeTempFile(tmpDir, fileName, buffer);

        await ctx.replyWithDocument(
          { source: filePath, filename: fileName },
          { caption: `${book.title}\n${book.author} [cached]` },
        );
        await ctx.deleteMessage().catch(() => {});
      } finally {
        cleanupTempDir(tmpDir);
      }

      if (ctx.from) addHistory(ctx.from.id, book);
      return;
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

        setCachedDownload(sourceId, buffer);

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

        if (ctx.from) addHistory(ctx.from.id, book);
      });
    } catch (err) {
      logger.error({ err, source: sourceName, bookId }, 'Download failed');
      await ctx.editMessageText('Download failed. The source may be unavailable.');
    }
  });

  // ── Admin commands ──
  bot.command('stats', async (ctx) => {
    if (!isAdmin(ctx.from?.id ?? 0)) return;

    const userCount = (db.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number }).c;
    const favCount = (db.prepare('SELECT COUNT(*) as c FROM favorites').get() as { c: number }).c;
    const histCount = (db.prepare('SELECT COUNT(*) as c FROM history').get() as { c: number }).c;
    const searchCacheCount = (db.prepare('SELECT COUNT(*) as c FROM search_cache').get() as { c: number }).c;

    await ctx.reply(
      `<b>Bot Stats</b>\n\n`
      + `Users: ${userCount}\n`
      + `Favorites saved: ${favCount}\n`
      + `Downloads recorded: ${histCount}\n`
      + `Search cache entries: ${searchCacheCount}\n`
      + `Sources: ${getSources().map((s) => s.name).join(', ')}`,
      { parse_mode: 'HTML' },
    );
  });

  bot.command('broadcast', async (ctx) => {
    const userId = ctx.from?.id;
    if (!isAdmin(userId ?? 0)) return;

    const text = ctx.message.text.slice('/broadcast'.length).trim();
    if (!text) return ctx.reply('Usage: /broadcast &lt;message&gt;');

    logger.info({ userId, textPreview: text.slice(0, 100) }, 'Admin: broadcast');

    const userIds = getAllUserIds();
    let sent = 0;
    let failed = 0;

    await ctx.reply(`Broadcasting to ${userIds.length} users...`);

    for (const uid of userIds) {
      try {
        await ctx.telegram.sendMessage(uid, text, { parse_mode: 'HTML' });
        sent++;
      } catch {
        failed++;
      }
    }

    logger.info({ totalSent: sent, totalFailed: failed }, 'Admin: broadcast done');
    await ctx.reply(`Done. Sent: ${sent}, Failed: ${failed}`);
  });

  bot.command('ban', async (ctx) => {
    if (!isAdmin(ctx.from?.id ?? 0)) return;
    const arg = ctx.message.text.slice('/ban'.length).trim();
    const targetId = Number(arg);
    if (!targetId) return ctx.reply('Usage: /ban &lt;user_id&gt;');

    logger.info({ adminId: ctx.from?.id, targetId }, 'Admin: ban');
    db.prepare('UPDATE users SET banned = 1 WHERE user_id = ?').run(targetId);
    await ctx.reply(`Banned user ${targetId}`);
  });

  bot.command('unban', async (ctx) => {
    if (!isAdmin(ctx.from?.id ?? 0)) return;
    const arg = ctx.message.text.slice('/unban'.length).trim();
    const targetId = Number(arg);
    if (!targetId) return ctx.reply('Usage: /unban &lt;user_id&gt;');

    logger.info({ adminId: ctx.from?.id, targetId }, 'Admin: unban');
    db.prepare('UPDATE users SET banned = 0 WHERE user_id = ?').run(targetId);
    await ctx.reply(`Unbanned user ${targetId}`);
  });

  bot.command('health', async (ctx) => {
    if (!isAdmin(ctx.from?.id ?? 0)) return;

    try {
      db.prepare('SELECT 1').get();
      logger.debug('Admin: health check OK');
      await ctx.reply('✅ Database OK');
    } catch (err) {
      logger.error({ err }, 'Admin: health check FAILED');
      await ctx.reply('❌ Database error');
    }
  });

  return bot;
}
