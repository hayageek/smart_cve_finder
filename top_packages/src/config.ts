import { readFileSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function loadDotEnv(): void {
  const envPath = resolve(PACKAGE_ROOT, '.env');
  if (!existsSync(envPath)) return;

  const text = readFileSync(envPath, 'utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv();

export function librariesIoKey(): string | undefined {
  return process.env.LIBRARIES_IO_KEY?.trim() || undefined;
}

/** Min ms between libraries.io requests (default ~44/min, under 50/min cap). */
export function librariesIoDelayMs(): number {
  const raw = process.env.LIBRARIES_IO_DELAY_MS?.trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 500) return n;
  }
  return 1_350;
}

/** Parallel registry metadata requests for native enrichment (not libraries.io). */
export function enrichConcurrency(): number {
  const raw = process.env.ENRICH_CONCURRENCY?.trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 1) return Math.min(10, Math.floor(n));
  }
  return 3;
}

export const USER_AGENT = 'secscan-top-packages/1.0 (security-research)';
