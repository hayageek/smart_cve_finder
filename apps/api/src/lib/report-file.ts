import path from 'path';
import fs from 'fs';
import { config } from '../config.js';

export function resolveReportAbsolutePath(reportPath: string | null): string | null {
  if (!reportPath) return null;
  const abs = path.isAbsolute(reportPath) ? reportPath : path.join(config.REPORTS_DIR, reportPath);
  return fs.existsSync(abs) ? abs : null;
}

export async function readReportMarkdown(reportPath: string | null): Promise<string | null> {
  const abs = resolveReportAbsolutePath(reportPath);
  if (!abs) return null;
  return fs.promises.readFile(abs, 'utf-8');
}
