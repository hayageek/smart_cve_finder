import 'dotenv/config';
import { setMaxListeners } from 'events';
import { logger } from './logger.js';

// Raise the global EventEmitter/EventTarget listener limit for concurrent
// @cursor/sdk runs (each run attaches AbortSignal listeners).
setMaxListeners(100);
import { scanWorker } from './scanner.worker.js';
import { exploitWorker } from './exploit.worker.js';

import { config } from './config.js';

logger.info('Workers starting...');
logger.info({ pid: process.pid }, 'Worker process');
logger.info(
  {
    scanMinStars: config.SCAN_MIN_STARS,
    scanMaxInactiveYears: config.SCAN_MAX_INACTIVE_YEARS,
    scanRequirePvr: config.SCAN_REQUIRE_PVR,
    githubTokenSet: Boolean(config.GITHUB_TOKEN?.trim()),
  },
  'Scan gates: min stars (0=off), max inactive years (0=off), require PVR',
);

scanWorker.on('ready', () => logger.info('Scan queue worker ready'));
exploitWorker.on('ready', () => logger.info('Exploit queue worker ready'));

scanWorker.on('active', (job) => logger.info({ jobId: job.id }, 'Scan job active'));
exploitWorker.on('active', (job) => logger.info({ jobId: job.id }, 'Exploit job active'));

scanWorker.on('completed', (job, result) =>
  logger.info({ jobId: job.id, result }, 'Scan job completed'),
);
exploitWorker.on('completed', (job, result) =>
  logger.info({ jobId: job.id, result }, 'Exploit job completed'),
);

async function shutdown() {
  logger.info('Shutting down workers...');
  await Promise.all([scanWorker.close(), exploitWorker.close()]);
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
