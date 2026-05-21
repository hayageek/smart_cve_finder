import pino from 'pino';
import path from 'path';
import { mkdirSync } from 'fs';
import { Redis } from 'ioredis';
import { config } from './config.js';
import { REDIS_CHANNELS, type LogLine } from '@secscan/shared';

mkdirSync(config.LOGS_DIR, { recursive: true });

const logFile = path.join(config.LOGS_DIR, 'workers.log');

const streams: pino.StreamEntry[] = [
  // Always write to file
  { stream: pino.destination({ dest: logFile, sync: false, mkdir: true }), level: 'info' as const },
  // Always write to stdout so docker compose logs works in all environments
  { stream: process.stdout, level: 'info' as const },
];

export const logger = pino({ level: 'info' }, pino.multistream(streams));

// ── Redis pub/sub bridge ─────────────────────────────────────────

let _publisher: Redis | null = null;

function getPublisher(): Redis {
  if (!_publisher) {
    _publisher = new Redis({
      host: config.REDIS_HOST,
      port: config.REDIS_PORT,
      ...(config.REDIS_PASSWORD ? { password: config.REDIS_PASSWORD } : {}),
      enableOfflineQueue: false,
      lazyConnect: true,
      retryStrategy: (times) => Math.min(times * 200, 5000),
    });
    _publisher.connect().catch(() => {});
    _publisher.on('error', () => {});
  }
  return _publisher;
}

function publishLine(line: LogLine): void {
  try {
    getPublisher().publish(REDIS_CHANNELS.WORKER_LOGS, JSON.stringify(line)).catch(() => {});
  } catch {}
}

// ── BridgedLogger ────────────────────────────────────────────────
//
// A thin wrapper around a pino child logger that intercepts each log
// call, forwards it to pino (→ file + stdout), and also publishes a
// structured LogLine to Redis so the API can relay it to the UI via
// Socket.IO LOG_LINE events.

export interface BridgedLogger {
  info(msg: string): void;
  info(obj: object, msg: string): void;
  warn(msg: string): void;
  warn(obj: object, msg: string): void;
  error(msg: string): void;
  error(obj: object, msg: string): void;
  debug(msg: string): void;
  debug(obj: object, msg: string): void;
  child(bindings: Record<string, unknown>): BridgedLogger;
}

function wrapPino(pinoInst: pino.Logger, worker: LogLine['worker'], jobId?: string): BridgedLogger {
  function makeMethod(level: LogLine['level']) {
    return (...args: [string] | [object, string]) => {
      (pinoInst[level] as (...a: unknown[]) => void)(...args);
      const msg = args.length === 1 ? String(args[0]) : String(args[1]);
      publishLine({ timestamp: new Date().toISOString(), level, worker, message: msg, jobId });
    };
  }

  return {
    info:  makeMethod('info')  as BridgedLogger['info'],
    warn:  makeMethod('warn')  as BridgedLogger['warn'],
    error: makeMethod('error') as BridgedLogger['error'],
    debug: makeMethod('debug') as BridgedLogger['debug'],
    child: (bindings) => {
      const childPino = pinoInst.child(bindings);
      const childJobId = (bindings.jobId as string | undefined) ?? jobId;
      return wrapPino(childPino, worker, childJobId);
    },
  };
}

export function createWorkerLogger(worker: LogLine['worker']): BridgedLogger {
  return wrapPino(logger.child({ worker }), worker);
}
