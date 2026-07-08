import dotenv from 'dotenv';
dotenv.config();

export const config = {
  botToken: process.env.BOT_TOKEN ?? '',
  adminIds: (process.env.ADMIN_IDS ?? '').split(',').map(Number).filter(Boolean),
  dataDir: process.env.DATA_DIR ?? './data',
  logLevel: process.env.LOG_LEVEL ?? 'info',
  maxConcurrentDownloads: Number(process.env.MAX_CONCURRENT_DOWNLOADS) || 3,
  cooldownSeconds: Number(process.env.COOLDOWN_SECONDS) || 5,
  maxFileSizeBytes: Number(process.env.MAX_FILE_SIZE_BYTES) || 50_000_000,
};

if (!config.botToken) {
  throw new Error('BOT_TOKEN is required');
}
