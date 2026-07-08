import { logger } from '../logger.js';

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export type AttemptOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; is503: boolean };

export type PassResult<T> = T | 'geo-blocked' | 'exhausted';

export async function tryMirrors<T>(
  label: string,
  mirrors: string[],
  attempt: (mirror: string) => Promise<AttemptOutcome<T>>,
  options?: { geoBlockThreshold?: number; delayBetweenMirrors?: number },
): Promise<PassResult<T>> {
  const threshold = options?.geoBlockThreshold ?? 3;
  const delay = options?.delayBetweenMirrors ?? 1000;
  let consecutive503 = 0;

  for (const mirror of mirrors) {
    const outcome = await attempt(mirror);

    if (outcome.ok) {
      logger.info({ label, mirror }, 'Attempt succeeded');
      return outcome.value;
    }

    if (outcome.is503) {
      consecutive503++;
      logger.debug({ label, mirror, consecutive503 }, '503, tracking for geo-block detection');
      if (consecutive503 >= threshold) {
        logger.warn({ label }, 'Consecutive 503s, likely geo-blocked');
        return 'geo-blocked';
      }
    } else {
      consecutive503 = 0;
    }

    await sleep(delay);
  }

  return 'exhausted';
}

export async function twoPassRetry<T>(
  label: string,
  mirrors: string[],
  attempt: (mirror: string) => Promise<AttemptOutcome<T>>,
  options?: { geoBlockThreshold?: number; delayBetweenMirrors?: number; delayBetweenPasses?: number },
): Promise<T> {
  const passDelay = options?.delayBetweenPasses ?? 3000;

  const first = await tryMirrors(label, mirrors, attempt, options);
  if (first === 'geo-blocked') {
    logger.warn({ label }, 'Geo-blocked, skipping retry');
    throw new Error(`${label} appears geo-blocked`);
  }
  if (first !== 'exhausted') return first;

  logger.info({ label }, 'First pass exhausted, retrying with delay');
  await sleep(passDelay);

  const second = await tryMirrors(label, mirrors, attempt, options);
  if (second === 'geo-blocked' || second === 'exhausted') {
    throw new Error(`${label} all attempts failed`);
  }
  return second;
}
