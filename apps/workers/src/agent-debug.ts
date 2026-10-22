import { config } from './config.js';

/** Verbose agent logging for Cursor and Claude runners. */
export function agentDebugEnabled(explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  return config.DEBUG_AGENT;
}
