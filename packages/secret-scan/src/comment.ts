import { readFileSync, existsSync } from 'fs';
import path from 'path';

/** Read a single 1-based line from a scanned file. */
export function readLineAt(cwd: string, filePath: string, lineNum: number): string | undefined {
  try {
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
    if (!existsSync(absPath)) return undefined;
    const lines = readFileSync(absPath, 'utf8').split(/\r?\n/);
    const idx = lineNum - 1;
    if (idx < 0 || idx >= lines.length) return undefined;
    return lines[idx];
  } catch {
    return undefined;
  }
}

/** True when `#` on the match line indicates the secret is commented out. */
export function isCommentedSecretLine(line: string, startColumn?: number): boolean {
  const hashIdx = line.indexOf('#');
  if (hashIdx === -1) return false;

  if (startColumn !== undefined && startColumn > 0) {
    return hashIdx < startColumn - 1;
  }

  return /^\s*#/.test(line);
}
