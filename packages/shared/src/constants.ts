export const QUEUE_NAMES = {
  REPO_SCAN: 'repo-scan-queue',
  CVE_SCAN: 'cve-scan-queue',
  EXPLOIT_GEN: 'exploit-gen-queue',
} as const;

export const SEVERITY_ORDER: Record<string, number> = {
  CRITICAL: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
};

/** Approximate CVSS 3.1 base scores mapped from CWE families */
export const CWE_CVSS_MAP: Record<string, number> = {
  'CWE-94': 9.8,   // Code Injection
  'CWE-78': 9.8,   // OS Command Injection
  'CWE-89': 9.8,   // SQL Injection
  'CWE-502': 9.8,  // Unsafe Deserialization
  'CWE-918': 7.5,  // SSRF
  'CWE-22': 7.5,   // Path Traversal
  'CWE-79': 6.1,   // XSS
  'CWE-352': 6.5,  // CSRF
  'CWE-287': 9.1,  // Improper Authentication
  'CWE-798': 9.8,  // Hard-coded Credentials
  'CWE-611': 9.1,  // XXE
  'CWE-434': 9.8,  // Unrestricted Upload
  'CWE-306': 9.8,  // Missing Authentication
  'CWE-862': 8.8,  // Missing Authorization
  'CWE-476': 7.5,  // Null Pointer Dereference
  'CWE-190': 7.8,  // Integer Overflow
  'CWE-125': 8.1,  // Out-of-bounds Read
  'CWE-416': 8.8,  // Use After Free
};

export const REDIS_CHANNELS = {
  WORKER_LOGS: 'worker:logs',
  WORKER_ACTIVITY: 'worker:activity',
} as const;

export const SOCKET_EVENTS = {
  DASHBOARD_STATS: 'dashboard:stats',
  QUEUE_STATS: 'queue:stats',
  JOB_PROGRESS: 'job:progress',
  JOB_ACTIVE: 'job:active',
  JOB_COMPLETED: 'job:completed',
  JOB_FAILED: 'job:failed',
  VULN_FOUND: 'vuln:found',
  EXPLOIT_READY: 'exploit:ready',
  LOG_LINE: 'log:line',
  ACTIVITY_EVENT: 'activity:event',
} as const;
