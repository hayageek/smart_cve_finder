import type { Server as HttpServer } from 'http';
import { Server } from 'socket.io';
import { SOCKET_EVENTS, type ActivityEvent, type LogLine, type JobProgressEvent, type QueueStats, type DashboardStats } from '@secscan/shared';
import { config } from '../config.js';

let io: Server;

export function initSocket(httpServer: HttpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: config.CORS_ORIGINS.split(','),
      methods: ['GET', 'POST'],
    },
  });

  io.on('connection', (socket) => {
    socket.on('disconnect', () => {});
  });

  return io;
}

export function getIo() {
  return io;
}

export function emitDashboardStats(stats: DashboardStats) {
  io?.emit(SOCKET_EVENTS.DASHBOARD_STATS, stats);
}

export function emitQueueStats(stats: QueueStats[]) {
  io?.emit(SOCKET_EVENTS.QUEUE_STATS, stats);
}

export function emitJobProgress(event: JobProgressEvent) {
  io?.emit(SOCKET_EVENTS.JOB_PROGRESS, event);
}

export function emitJobActive(event: JobProgressEvent) {
  io?.emit(SOCKET_EVENTS.JOB_ACTIVE, event);
}

export function emitJobCompleted(event: JobProgressEvent) {
  io?.emit(SOCKET_EVENTS.JOB_COMPLETED, event);
}

export function emitJobFailed(event: JobProgressEvent & { error: string }) {
  io?.emit(SOCKET_EVENTS.JOB_FAILED, event);
}

export function emitVulnFound(data: { scanJobId: string; repoUrl: string; count: number; severities: string[] }) {
  io?.emit(SOCKET_EVENTS.VULN_FOUND, data);
}

export function emitExploitReady(data: { vulnId: string; repoUrl: string; cwe: string }) {
  io?.emit(SOCKET_EVENTS.EXPLOIT_READY, data);
}

export function emitLogLine(line: LogLine) {
  io?.emit(SOCKET_EVENTS.LOG_LINE, line);
}

export function emitActivityEvent(event: ActivityEvent) {
  io?.emit(SOCKET_EVENTS.ACTIVITY_EVENT, event);
}
