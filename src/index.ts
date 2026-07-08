import { mkdirSync } from 'node:fs';
import { config } from './config.js';
import { createBot } from './bot/index.js';

mkdirSync(config.dataDir, { recursive: true });

const bot = createBot();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

bot.launch().then(() => {
  console.log('Bot started');
});
