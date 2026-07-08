import type { Context, MiddlewareFn } from 'telegraf';
import { config } from '../config.js';

const userCooldowns = new Map<number, number>();

export function cooldownMiddleware(): MiddlewareFn<Context> {
  return (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return next();

    const now = Date.now();
    const last = userCooldowns.get(userId);

    if (last && now - last < config.cooldownSeconds * 1000) {
      const remaining = Math.ceil((config.cooldownSeconds * 1000 - (now - last)) / 1000);
      return ctx.reply(`Please wait ${remaining}s before the next request.`);
    }

    userCooldowns.set(userId, now);
    return next();
  };
}

export function errorHandler(): MiddlewareFn<Context> {
  return (ctx, next) => {
    return next().catch((err: Error) => {
      console.error(`Error for user ${ctx.from?.id}:`, err.message);
      return ctx.reply('Something went wrong. Please try again later.').catch(() => {});
    });
  };
}
