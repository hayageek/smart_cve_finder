import { USER_AGENT } from './config.js';
import { sleep } from './rate-limit.js';

/** libraries.io allows 50 req/min — stay under with margin (default ~44/min). */
let minIntervalMs = 1_350;
let lastRequestAt = 0;
let queue: Promise<void> = Promise.resolve();

const DEFAULT_TIMEOUT_MS = 45_000;

export function setLibrariesIoMinInterval(ms: number): void {
  minIntervalMs = Math.max(500, ms);
}

export function librariesIoMinInterval(): number {
  return minIntervalMs;
}

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function waitForSlot(): Promise<void> {
  const now = Date.now();
  const wait = Math.max(0, lastRequestAt + minIntervalMs - now);
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

function retryDelayMs(res: Response, attempt: number): number {
  const retryAfter = res.headers.get('Retry-After');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  }
  return Math.min(60_000, 2_000 * 2 ** attempt);
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

export type LibrariesIoFetchOptions = RequestInit & {
  /** Max retries on HTTP 429/5xx (default 6). */
  maxRetries?: number;
  /** Request timeout in ms (default 45000). */
  timeoutMs?: number;
  onWait?: (ms: number, reason: string) => void;
};

/**
 * Serialized, rate-limited fetch for libraries.io.
 * All calls share one queue so concurrent ecosystems cannot burst past the limit.
 */
export function librariesIoFetch(
  url: string | URL,
  options: LibrariesIoFetchOptions = {},
): Promise<Response> {
  const { maxRetries = 6, timeoutMs = DEFAULT_TIMEOUT_MS, onWait, ...init } = options;

  return enqueue(async () => {
    let attempt = 0;

    while (true) {
      await waitForSlot();

      let res: Response;
      try {
        res = await fetch(url, {
          ...init,
          headers: { 'User-Agent': USER_AGENT, ...init.headers },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        if (attempt >= maxRetries) throw err;
        const delay = retryDelayMs(new Response(null, { status: 503 }), attempt);
        attempt++;
        onWait?.(delay, `network error (retry ${attempt}/${maxRetries})`);
        await sleep(delay);
        continue;
      }

      if (!isRetryableStatus(res.status)) return res;

      if (attempt >= maxRetries) return res;

      const delay = retryDelayMs(res, attempt);
      attempt++;
      onWait?.(delay, `HTTP ${res.status} (retry ${attempt}/${maxRetries})`);
      await sleep(delay);
    }
  });
}
