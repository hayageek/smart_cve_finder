/** Redact a secret for safe logging and LLM prompts — never pass raw values to Cursor. */
export function redactSecret(value: string, visible = 4): string {
  const trimmed = value.trim();
  if (trimmed.length <= visible * 2) return '*'.repeat(Math.min(trimmed.length, 8));
  return `${trimmed.slice(0, visible)}${'*'.repeat(Math.max(4, trimmed.length - visible * 2))}${trimmed.slice(-visible)}`;
}
