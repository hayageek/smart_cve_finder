import { config } from './config.js';
import { logger } from './logger.js';

export async function sendWebhook(payload: Record<string, unknown>) {
  if (!config.NOTIFY_WEBHOOK_URL) return;
  try {
    await fetch(config.NOTIFY_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    logger.warn({ err }, 'Webhook notification failed');
  }
}

export async function notifyOnCritical(repoUrl: string, vulnCount: number) {
  if (!config.NOTIFY_ON_CRITICAL) return;
  await sendWebhook({
    event: 'critical_vuln_found',
    repoUrl,
    criticalVulnCount: vulnCount,
    timestamp: new Date().toISOString(),
  });
}

export async function notifyOnScanComplete(repoUrl: string, vulnCount: number, scanJobId: string) {
  if (!config.NOTIFY_ON_SCAN_COMPLETE) return;
  await sendWebhook({
    event: 'scan_complete',
    repoUrl,
    vulnCount,
    scanJobId,
    timestamp: new Date().toISOString(),
  });
}
