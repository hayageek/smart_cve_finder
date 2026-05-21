import fs from 'fs';
import path from 'path';
import type { LogLine } from '@secscan/shared';

const PINO_LEVEL: Record<number, LogLine['level']> = {
  10: 'debug',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'error',
};

function inferWorker(record: Record<string, unknown>): LogLine['worker'] {
  const w = record.worker as string | undefined;
  if (w === 'scanner' || w === 'cve' || w === 'exploit' || w === 'api') return w;
  const msg = String(record.msg ?? '');
  if (msg.includes('CVE scan') || msg.includes('cve-scan')) return 'scanner';
  if (msg.includes('Exploit')) return 'exploit';
  return 'scanner';
}

export function parsePinoLogLine(line: string): LogLine | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const o = JSON.parse(trimmed) as Record<string, unknown>;
    const levelNum = typeof o.level === 'number' ? o.level : 30;
    const time = o.time;
    const timestamp =
      typeof time === 'number'
        ? new Date(time).toISOString()
        : typeof time === 'string'
          ? new Date(time).toISOString()
          : new Date().toISOString();

    return {
      timestamp,
      level: PINO_LEVEL[levelNum] ?? 'info',
      worker: inferWorker(o),
      message: String(o.msg ?? ''),
      jobId: typeof o.jobId === 'string' ? o.jobId : undefined,
    };
  } catch {
    return null;
  }
}

export function readWorkerLogTail(logsDir: string, tail: number): LogLine[] {
  const logFile = path.join(logsDir, 'workers.log');
  if (!fs.existsSync(logFile)) return [];

  const content = fs.readFileSync(logFile, 'utf-8');
  const rawLines = content.split('\n').filter((l) => l.trim().startsWith('{'));
  const slice = tail > 0 ? rawLines.slice(-tail) : rawLines;

  return slice
    .map(parsePinoLogLine)
    .filter((l): l is LogLine => l !== null);
}
