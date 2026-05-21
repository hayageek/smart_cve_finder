import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  getFindingDetails,
  searchFindings,
  setFindingExploitable,
} from '../services/findings.js';
import { saveFindingArtifacts } from '../services/artifacts.js';

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
        'Use search_findings to discover IDs by cwe_id, repo_url, or org.',
        'Use save_finding_artifacts to persist report.md, payload.py, exploit.py.',
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
    'Save IDE-generated report.md, payload.py, and/or exploit.py to the reports folder for a finding',
    {
      finding_id: z.string().describe('Vulnerability.id (UUID)'),
      report_md: z.string().optional().describe('Markdown report content'),
      payload_py: z.string().optional().describe('payload.py content'),
      exploit_py: z.string().optional().describe('exploit.py content'),
    },
    async ({ finding_id, report_md, payload_py, exploit_py }) => {
      try {
        const saved = await saveFindingArtifacts(finding_id, {
          reportMd: report_md,
          payloadPy: payload_py,
          exploitPy: exploit_py,
        });
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
  'search_findings',
  'save_finding_artifacts',
  'set_finding_exploitable',
] as const;
