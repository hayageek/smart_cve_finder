import 'dotenv/config';
import { setMaxListeners } from 'events';
import { logger } from './logger.js';

// Raise the global EventEmitter/EventTarget listener limit for concurrent
// @cursor/sdk runs (each run attaches AbortSignal listeners).
setMaxListeners(100);
import { scanWorker, cveWorker } from './scanner.worker.js';
import { exploitWorker } from './exploit.worker.js';

logger.info('Workers starting...');
logger.info({ pid: process.pid }, 'Worker process');

scanWorker.on('ready', () => logger.info('Scan queue worker ready'));
cveWorker.on('ready', () => logger.info('CVE scan queue worker ready'));
exploitWorker.on('ready', () => logger.info('Exploit queue worker ready'));

scanWorker.on('active', (job) => logger.info({ jobId: job.id }, 'Scan job active'));
cveWorker.on('active', (job) => logger.info({ jobId: job.id }, 'CVE scan job active'));
exploitWorker.on('active', (job) => logger.info({ jobId: job.id }, 'Exploit job active'));

scanWorker.on('completed', (job, result) =>
  logger.info({ jobId: job.id, result }, 'Scan job completed'),
);
cveWorker.on('completed', (job, result) =>
  logger.info({ jobId: job.id, result }, 'CVE scan job completed'),
);
exploitWorker.on('completed', (job, result) =>
  logger.info({ jobId: job.id, result }, 'Exploit job completed'),
);

async function shutdown() {
  logger.info('Shutting down workers...');
  await Promise.all([scanWorker.close(), cveWorker.close(), exploitWorker.close()]);
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
