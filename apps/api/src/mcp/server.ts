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
] as const;
