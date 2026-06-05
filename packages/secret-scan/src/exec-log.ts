/** Shell-safe one-line representation of execFile(bin, args). */
export function formatExecCommand(bin: string, args: string[]): string {
  const quote = (s: string): string => {
    if (/^[a-zA-Z0-9_./:@%+=,-]+$/.test(s)) return s;
    return `'${s.replace(/'/g, `'\\''`)}'`;
  };
  return [bin, ...args.map(quote)].join(' ');
}

/** Truncate long stderr for log lines. */
export function truncateForLog(text: string, max = 500): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max)}… (${oneLine.length} chars)`;
}
