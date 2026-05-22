import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  getFindingDetails,
  getNextUnexploitedFinding,
  searchFindings,
  setFindingExploitable,
} from '../services/findings.js';
import {
  decodeArtifactBase64,
  saveFindingArtifacts,
  saveFindingArtifactBuffers,
} from '../services/artifacts.js';
import {
  enqueueScans,
  getScanQueueOverview,
  getScanStatus,
} from '../services/scans.js';

export function createMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: 'secscan-vulnerabilities',
      version: '1.0.0',
    },
    {
      instructions: [
        'MCP server for SecScan vulnerability research.',
        'finding_id is the Vulnerability.id (UUID) shown in the SecScan UI.',
        'Use get_next_unexploited_finding to claim the next finding with no exploit (IDE workflow).',
        'Use search_findings to discover IDs by cwe_id, repo_url, or org.',
        'Use save_finding_artifacts with full file TEXT (not host paths). Prefer report_md_base64 for large files.',
        'Files are written under REPORTS_DIR on the API server (Docker volume), not on your laptop path.',
        'Use set_finding_exploitable after analysis (maps to exploitStatus done/failed).',
        'Use enqueue_scan to add git repos or registry packages (npm, pip, cargo, go, gem) to the scanner queue (same rules as CSV import).',
        'Use get_scan_status to check repo/scan job progress by repo_id, repo_url, or scan_job_id.',
        'Use get_scan_queue_stats for BullMQ queue depths and pending DB scan jobs.',
      ].join(' '),
    },
  );

  server.tool(
    'get_finding_details',
    'Get full vulnerability details and artifact contents (report.md, exploit.py, payload.py) by finding_id',
    { finding_id: z.string().describe('Vulnerability.id (UUID)') },
    async ({ finding_id }) => {
      const details = await getFindingDetails(finding_id);
      if (!details) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Finding not found' }) }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(details, null, 2) }],
      };
    },
  );

  server.tool(
    'get_next_unexploited_finding',
    'Get the next vulnerability with no exploit available (exploitStatus null) for IDE research, highest severity first',
    {
      cwe_id: z.string().optional().describe('CWE filter, e.g. CWE-94'),
      repo_url: z.string().optional().describe('Substring match on repo URL'),
      org: z.string().optional().describe('Git org segment in repo URL'),
      min_severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']).optional(),
      include_failed: z.boolean().optional().default(false).describe('Also return failed attempts without a successful exploit'),
    },
    async ({ cwe_id, repo_url, org, min_severity, include_failed }) => {
      const result = await getNextUnexploitedFinding({
        cwe: cwe_id,
        repoUrl: repo_url,
        org,
        minSeverity: min_severity,
        includeFailed: include_failed,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    'search_findings',
    'Search vulnerabilities by CWE, repository URL, and/or GitHub/GitLab org',
    {
      cwe_id: z.string().optional().describe('CWE filter, e.g. CWE-94'),
      repo_url: z.string().optional().describe('Substring match on repo URL'),
      org: z.string().optional().describe('Git org segment in repo URL, e.g. hayageek'),
      page: z.number().int().min(1).optional().default(1),
      page_size: z.number().int().min(1).max(100).optional().default(20),
    },
    async ({ cwe_id, repo_url, org, page, page_size }) => {
      const result = await searchFindings({
        cwe: cwe_id,
        repoUrl: repo_url,
        org,
        page,
        pageSize: page_size,
        dropped: 'no',
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    'save_finding_artifacts',
    'Upload report.md, payload.py, and/or exploit.py file CONTENTS to the API server (writes into Docker REPORTS_DIR). Do not pass host file paths.',
    {
      finding_id: z.string().describe('Vulnerability.id (UUID)'),
      report_md: z.string().optional().describe('Full markdown text of report.md'),
      payload_py: z.string().optional().describe('Full Python source of payload.py'),
      exploit_py: z.string().optional().describe('Full Python source of exploit.py'),
      report_md_base64: z.string().optional().describe('Base64-encoded report.md'),
      payload_py_base64: z.string().optional().describe('Base64-encoded payload.py'),
      exploit_py_base64: z.string().optional().describe('Base64-encoded exploit.py'),
    },
    async ({
      finding_id,
      report_md,
      payload_py,
      exploit_py,
      report_md_base64,
      payload_py_base64,
      exploit_py_base64,
    }) => {
      try {
        const hasB64 =
          report_md_base64 !== undefined ||
          payload_py_base64 !== undefined ||
          exploit_py_base64 !== undefined;

        let saved;
        if (hasB64) {
          const buffers: Parameters<typeof saveFindingArtifactBuffers>[1] = {};
          if (report_md_base64 !== undefined) {
            buffers.reportMd = decodeArtifactBase64(report_md_base64);
          }
          if (payload_py_base64 !== undefined) {
            buffers.payloadPy = decodeArtifactBase64(payload_py_base64);
          }
          if (exploit_py_base64 !== undefined) {
            buffers.exploitPy = decodeArtifactBase64(exploit_py_base64);
          }
          saved = await saveFindingArtifactBuffers(finding_id, buffers);
        } else {
          saved = await saveFindingArtifacts(finding_id, {
            reportMd: report_md,
            payloadPy: payload_py,
            exploitPy: exploit_py,
          });
        }

        if (!saved) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: 'Finding not found' }) }],
            isError: true,
          };
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(saved, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: String(err) }) }],
          isError: true,
        };
      }
    },
  );

  const scanTargetSchema = z.object({
    git_url: z.string().optional().describe('Git clone URL, e.g. https://github.com/org/repo'),
    package_name: z.string().optional().describe('Registry package name or Go module path, e.g. express or github.com/gin-gonic/gin'),
    package_type: z.enum(['npm', 'pip', 'cargo', 'go', 'gem']).optional().describe('Required with package_name'),
    package_version: z.string().optional().describe('Package version; omit for latest'),
    is_private: z.boolean().optional().describe('For git repos only — mark as private/internal'),
  });

  server.tool(
    'enqueue_scan',
    'Add one or more git repos or registry packages to the scanner queue. Deduplicates by canonical key. Skips already-scanned repos unless force=true.',
    {
      targets: z
        .array(scanTargetSchema)
        .min(1)
        .describe('List of repos/packages to queue (same format as CSV import)'),
      force: z
        .boolean()
        .optional()
        .default(false)
        .describe('Re-scan repos that were already scanned (status done/skipped)'),
    },
    async ({ targets, force }) => {
      try {
        const parsedTargets = targets.map((t) => {
          if (t.git_url) {
            return { gitUrl: t.git_url, isPrivate: t.is_private };
          }
          if (t.package_name && t.package_type) {
            return {
              packageName: t.package_name,
              packageType: t.package_type,
              packageVersion: t.package_version,
            };
          }
          return { gitUrl: '' };
        });

        const result = await enqueueScans(parsedTargets, { force });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: String(err) }) }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'get_scan_status',
    'Get repo and scan job status. Lookup by repo_id, repo_url (canonical key or git URL), and/or scan_job_id.',
    {
      repo_id: z.string().optional().describe('Repo.id (cuid)'),
      repo_url: z
        .string()
        .optional()
        .describe('Canonical url key, git clone URL, or substring match'),
      scan_job_id: z.string().optional().describe('ScanJob.id — returns that job plus repo context'),
    },
    async ({ repo_id, repo_url, scan_job_id }) => {
      try {
        const status = await getScanStatus({
          repoId: repo_id,
          repoUrl: repo_url,
          scanJobId: scan_job_id,
        });
        if (!status) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: 'Not found' }) }],
            isError: true,
          };
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(status, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: String(err) }) }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'get_scan_queue_stats',
    'Overview of scanner queue depth (BullMQ) and pending/active scan jobs in the database',
    {},
    async () => {
      try {
        const overview = await getScanQueueOverview();
        return {
          content: [{ type: 'text', text: JSON.stringify(overview, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: String(err) }) }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'set_finding_exploitable',
    'Mark a finding as exploitable (exploitStatus=done) or not exploitable (exploitStatus=failed)',
    {
      finding_id: z.string().describe('Vulnerability.id (UUID)'),
      exploitable: z.boolean().describe('true = exploitable, false = not exploitable'),
      note: z.string().optional().describe('Optional note when marking not exploitable'),
    },
    async ({ finding_id, exploitable, note }) => {
      const updated = await setFindingExploitable(finding_id, exploitable, note);
      if (!updated) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Finding not found' }) }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(updated, null, 2) }],
      };
    },
  );

  return server;
}

export const MCP_TOOL_NAMES = [
  'get_finding_details',
  'get_next_unexploited_finding',
  'search_findings',
  'save_finding_artifacts',
  'set_finding_exploitable',
  'enqueue_scan',
  'get_scan_status',
  'get_scan_queue_stats',
] as const;
