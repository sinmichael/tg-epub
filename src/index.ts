import { logger } from './logger.js';
import { createBot } from './bot/index.js';

const bot = createBot();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

bot.launch().then(() => {
  logger.info('Bot started');
});
