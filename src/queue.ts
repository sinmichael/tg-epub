import pLimit from 'p-limit';
import { config } from './config.js';

const limit = pLimit(config.maxConcurrentDownloads);

export function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  return limit(fn);
}
