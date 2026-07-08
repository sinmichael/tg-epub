import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from './config.js';

export function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'tg-epub-'));
}

export function cleanupTempDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
}

export function writeTempFile(dir: string, name: string, buffer: Buffer): string {
  const path = join(dir, name);
  writeFileSync(path, buffer);
  return path;
}

export function removeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // ignore
  }
}

export function isFileTooLarge(bytes: number): boolean {
  return bytes > config.maxFileSizeBytes;
}
