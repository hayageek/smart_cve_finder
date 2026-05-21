import { useEffect, useState } from 'react';
import { getSocket, SOCKET_EVENTS } from '../lib/socket.ts';
import { api } from '../lib/api.ts';
import type { ActivityEvent, LogLine, QueueStats, DashboardStats, JobProgressEvent } from '@secscan/shared';

export function useLiveQueueStats() {
  const [stats, setStats] = useState<QueueStats[]>([]);
  useEffect(() => {
    const s = getSocket();
    s.on(SOCKET_EVENTS.QUEUE_STATS, setStats);
    return () => { s.off(SOCKET_EVENTS.QUEUE_STATS, setStats); };
  }, []);
  return stats;
}

export function useLiveDashboardStats() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  useEffect(() => {
    const s = getSocket();
    s.on(SOCKET_EVENTS.DASHBOARD_STATS, setStats);
    return () => { s.off(SOCKET_EVENTS.DASHBOARD_STATS, setStats); };
  }, []);
  return stats;
}

export function useActivityFeed(max = 50) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  useEffect(() => {
    const s = getSocket();
    const handler = (evt: ActivityEvent) => {
      setEvents((prev) => [evt, ...prev].slice(0, max));
    };
    s.on(SOCKET_EVENTS.ACTIVITY_EVENT, handler);
    return () => { s.off(SOCKET_EVENTS.ACTIVITY_EVENT, handler); };
  }, [max]);
  return events;
}

export function useLiveJobProgress() {
  const [jobs, setJobs] = useState<Record<string, JobProgressEvent>>({});
  useEffect(() => {
    const s = getSocket();
    const update = (evt: JobProgressEvent) => {
      setJobs((prev) => ({ ...prev, [evt.scanJobId]: evt }));
    };
    const remove = (evt: JobProgressEvent) => {
      setJobs((prev) => {
        const next = { ...prev };
        delete next[evt.scanJobId];
        return next;
      });
    };
    s.on(SOCKET_EVENTS.JOB_PROGRESS, update);
    s.on(SOCKET_EVENTS.JOB_ACTIVE, update);
    s.on(SOCKET_EVENTS.JOB_COMPLETED, remove);
    s.on(SOCKET_EVENTS.JOB_FAILED, remove);
    return () => {
      s.off(SOCKET_EVENTS.JOB_PROGRESS, update);
      s.off(SOCKET_EVENTS.JOB_ACTIVE, update);
      s.off(SOCKET_EVENTS.JOB_COMPLETED, remove);
      s.off(SOCKET_EVENTS.JOB_FAILED, remove);
    };
  }, []);
  return Object.values(jobs);
}

function logKey(line: LogLine): string {
  return `${line.timestamp}|${line.level}|${line.worker}|${line.jobId ?? ''}|${line.message}`;
}

function mergeLogLines(history: LogLine[], live: LogLine[], maxLines: number): LogLine[] {
  const seen = new Set<string>();
  const merged: LogLine[] = [];
  for (const line of [...history, ...live]) {
    const key = logKey(line);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(line);
  }
  return merged.slice(-maxLines);
}

export function useLiveLogs(maxLines = 500) {
  const [lines, setLines] = useState<LogLine[]>([]);
  useEffect(() => {
    const s = getSocket();
    const handler = (line: LogLine) => {
      setLines((prev) => [...prev, line].slice(-maxLines));
    };
    s.on(SOCKET_EVENTS.LOG_LINE, handler);
    return () => { s.off(SOCKET_EVENTS.LOG_LINE, handler); };
  }, [maxLines]);
  return lines;
}

/** Historical logs from workers.log plus live Socket.IO stream (survives page refresh). */
export function useWorkerLogs(maxLines = 500, historyTail = 500) {
  const [history, setHistory] = useState<LogLine[]>([]);
  const [live, setLive] = useState<LogLine[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.getWorkerLogs(historyTail)
      .then((res) => {
        if (!cancelled) {
          setHistory(res.lines as LogLine[]);
          setHistoryLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) setHistoryLoaded(true);
      });
    return () => { cancelled = true; };
  }, [historyTail]);

  useEffect(() => {
    const s = getSocket();
    const handler = (line: LogLine) => {
      setLive((prev) => [...prev, line].slice(-maxLines));
    };
    s.on(SOCKET_EVENTS.LOG_LINE, handler);
    return () => { s.off(SOCKET_EVENTS.LOG_LINE, handler); };
  }, [maxLines]);

  return {
    lines: mergeLogLines(history, live, maxLines),
    historyLoaded,
    clearDisplay: () => {
      setHistory([]);
      setLive([]);
    },
  };
}
